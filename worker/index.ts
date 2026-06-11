import { collectCursorOutput, createCursorCompletion, resolveCursorModel, streamCursorText } from "./cursor";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "./cursor-sdk";
import { sha256Hex } from "./crypto";
import { bearerToken, errorResponse, HttpError, json, notFound, optionsResponse, parseJsonBody, sseResponse, unauthorized } from "./http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  prepareChatRequest,
  prepareOpencodeSdkChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseInputItemsObject,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toolCallRetryHint,
  toOpenAiToolCalls
} from "./openai";
import { encodeSse } from "./sse";
import type { Deps, Env, ExecutionContext } from "./types";
import type { CursorTextEvent } from "./cursor";
import type { ToolCallContext } from "./openai";
import type { OpenAiToolSpec } from "./openai";

// The bearer token IS the caller's Cursor API key; nothing is stored.
type AuthResult = { cursorApiKey: string };

interface StoredResponseState {
  ownerKey: string;
  id: string;
  response?: Record<string, unknown>;
  inputItems: unknown[];
  outputItems: unknown[];
  sdkSessionKey?: string;
  updatedAt: number;
}

const responseState = new Map<string, StoredResponseState>();
const RESPONSE_STATE_LIMIT = 512;

const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps = defaultDeps): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse();
  const url = new URL(request.url);

  try {
    if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return json({ ok: true });
    }

    const route = matchOpenAiRoute(url.pathname);
    if (route) {
      return await handleOpenAiRoute(request, env, ctx, deps, route);
    }

    return notFound();
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleOpenAiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
  route: OpenAiRoute
): Promise<Response> {
  if (route.kind === "models") {
    const auth = authenticate(request);
    if (!auth) return unauthorized();
    if (request.method !== "GET") return notFound();
    return json(modelList({ opencode: route.surface === "opencodev2", sdk: route.surface === "opencodev2" }));
  }

  if (route.kind === "response" || route.kind === "responseInputItems" || route.kind === "responseCancel") {
    const auth = authenticate(request);
    if (!auth) return unauthorized();
    return handleResponseStateRoute(request, auth, route);
  }

  if (route.kind !== "chat" && route.kind !== "responses") return notFound();

  if (request.method !== "POST") return notFound();
  const auth = authenticate(request);
  if (!auth) return unauthorized();

  const body = await parseJsonBody<unknown>(request);
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : "composer-2.5";
  const cursorModel = resolveCursorModel(requestedModel);
  if (route.surface === "opencodev2" && route.kind === "chat") {
    return handleOpenCodeSdkChatRoute(request, env, ctx, deps, auth, body, cursorModel);
  }

  const responseOwner = route.kind === "responses" ? await responseOwnerKey(auth) : undefined;
  const previousResponseId = route.kind === "responses" ? previousResponseIdFromBody(body) : undefined;
  const previousState = previousResponseId && responseOwner ? getResponseState(responseOwner, previousResponseId) : undefined;
  if (previousResponseId && !previousState) throw new HttpError("Response not found", 404, "not_found");
  const prepared =
    route.kind === "chat"
      ? prepareChatRequest(body, cursorModel)
      : prepareResponsesRequest(body, cursorModel, {
          previousOutput: previousState?.outputItems,
          previousInputItems: previousState?.inputItems
        });
  const id = `${route.kind === "chat" ? "chatcmpl" : "resp"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  const sdkSessionKey = route.kind === "responses"
    ? previousState?.sdkSessionKey || sessionAffinity(request) || id
    : sessionAffinity(request);
  const completionRoute: CompletionRoute =
    route.kind === "chat" ? { ...route, kind: "chat" } : { ...route, kind: "responses" };

  if (shouldUseSdkForPreparedRoute(env, completionRoute)) {
    return await handleSdkPreparedOpenAiRoute({
      route: completionRoute,
      prepared,
      request,
      env,
      ctx,
      deps,
      auth,
      id,
      created,
      responseOwner,
      sdkSessionKey
    });
  }

  const completion = await createCursorCompletion(env, deps, auth.cursorApiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel
  });

  if (prepared.stream) {
    return streamOpenAiResponse(route.kind, completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onDone: async (text, completionChars, toolCalls) => {
        if (route.kind === "responses" && responseOwner) {
          const completed = responseObject({
            id,
            created,
            model: prepared.model,
            text,
            toolCalls,
            promptChars: prepared.promptChars,
            metadata: prepared.responseMetadata
          });
          storeResponseState(responseOwner, {
            id,
            response: completed,
            inputItems: prepared.responseInputItems ?? [],
            outputItems: (completed.output as unknown[]) ?? [],
            store: prepared.storeResponse !== false,
            sdkSessionKey,
            now: deps.now().getTime()
          });
        }
      },
      onError: async () => undefined
    }, ctx);
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });
  if (route.kind === "chat") {
    return json(
      chatCompletionResponse({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata
      })
    );
  }
  const response = responseObject({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata
    });
  if (responseOwner) {
    storeResponseState(responseOwner, {
      id,
      response,
      inputItems: prepared.responseInputItems ?? [],
      outputItems: (response.output as unknown[]) ?? [],
      store: prepared.storeResponse !== false,
      sdkSessionKey,
      now: deps.now().getTime()
    });
  }
  return json(response);
}

async function handleSdkPreparedOpenAiRoute(input: {
  route: CompletionRoute;
  prepared: ReturnType<typeof prepareChatRequest> | ReturnType<typeof prepareResponsesRequest>;
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  deps: Deps;
  auth: AuthResult;
  id: string;
  created: number;
  responseOwner?: string;
  sdkSessionKey?: string;
}): Promise<Response> {
  const completion = await createCursorSdkCompletion(input.env, input.deps, input.auth.cursorApiKey, {
    prompt: input.prepared.prompt,
    model: input.prepared.cursorModel,
    sessionKey: input.sdkSessionKey || sessionAffinity(input.request),
    workingDirectory: input.prepared.toolContext?.workingDirectory,
    clientTools: input.prepared.tools,
    requiresLocalTool: input.prepared.requiresLocalTool,
    allowToolCall: (toolCall) => {
      if (!input.prepared.tools.length) return "No client tool inventory was available for this request.";
      const toolCalls = toOpenAiToolCalls({
        toolCalls: [toolCall],
        tools: input.prepared.tools,
        responseId: "probe",
        context: input.prepared.toolContext
      });
      return toolCalls.length > 0
        || toolCallRetryHint({ toolCall, tools: input.prepared.tools, context: input.prepared.toolContext });
    }
  });

  if (input.prepared.stream) {
    return streamOpenAiEvents(input.route.kind, completion.stream, {
      id: input.id,
      created: input.created,
      model: input.prepared.model,
      promptChars: input.prepared.promptChars,
      includeUsage: input.prepared.includeUsage,
      metadata: input.prepared.responseMetadata,
      tools: input.prepared.tools,
      context: input.prepared.toolContext,
      onDone: async (text, completionChars, toolCalls) => {
        if (input.route.kind === "responses" && input.responseOwner) {
          const completed = responseObject({
            id: input.id,
            created: input.created,
            model: input.prepared.model,
            text,
            toolCalls,
            promptChars: input.prepared.promptChars,
            metadata: input.prepared.responseMetadata
          });
          storeResponseState(input.responseOwner, {
            id: input.id,
            response: completed,
            inputItems: input.prepared.responseInputItems ?? [],
            outputItems: (completed.output as unknown[]) ?? [],
            store: input.prepared.storeResponse !== false,
            sdkSessionKey: input.sdkSessionKey,
            now: input.deps.now().getTime()
          });
        }
      },
      onError: async () => undefined
    }, input.ctx);
  }

  const output = await collectCursorSdkOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: input.prepared.tools,
    responseId: input.id,
    context: input.prepared.toolContext
  });
  if (input.route.kind === "chat") {
    return json(
      chatCompletionResponse({
        id: input.id,
        created: input.created,
        model: input.prepared.model,
        text: output.text,
        toolCalls,
        promptChars: input.prepared.promptChars,
        metadata: input.prepared.responseMetadata
      })
    );
  }

  const response = responseObject({
    id: input.id,
    created: input.created,
    model: input.prepared.model,
    text: output.text,
    toolCalls,
    promptChars: input.prepared.promptChars,
    metadata: input.prepared.responseMetadata
  });
  if (input.responseOwner) {
    storeResponseState(input.responseOwner, {
      id: input.id,
      response,
      inputItems: input.prepared.responseInputItems ?? [],
      outputItems: (response.output as unknown[]) ?? [],
      store: input.prepared.storeResponse !== false,
      sdkSessionKey: input.sdkSessionKey,
      now: input.deps.now().getTime()
    });
  }
  return json(response);
}

function shouldUseSdkForPreparedRoute(env: Env, route: CompletionRoute): boolean {
  if (!hasConfiguredSdkBridge(env)) return false;
  return route.kind === "responses" || route.kind === "chat";
}

function hasConfiguredSdkBridge(env: Env): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

async function handleOpenCodeSdkChatRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
  auth: AuthResult,
  body: unknown,
  cursorModel: { id: string } | undefined
): Promise<Response> {
  const prepared = prepareOpencodeSdkChatRequest(body, cursorModel);
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  const completion = await createCursorSdkCompletion(env, deps, auth.cursorApiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel,
    sessionKey: sessionAffinity(request),
    workingDirectory: prepared.toolContext?.workingDirectory,
    clientTools: prepared.tools,
    requiresLocalTool: prepared.requiresLocalTool,
    allowToolCall: (toolCall) => {
      const toolCalls = toOpenAiToolCalls({
        toolCalls: [toolCall],
        tools: prepared.tools,
        responseId: "probe",
        context: prepared.toolContext
      });
      return toolCalls.length > 0
        || toolCallRetryHint({ toolCall, tools: prepared.tools, context: prepared.toolContext });
    }
  });

  if (prepared.stream) {
    return streamOpenAiEvents("chat", completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onDone: async () => undefined,
      onError: async () => undefined
    }, ctx);
  }

  const output = await collectCursorSdkOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });
  return json(
    chatCompletionResponse({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata
    })
  );
}

function streamOpenAiResponse(
  kind: "chat" | "responses",
  cursorStream: Response,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    metadata?: Record<string, unknown>;
    tools: OpenAiToolSpec[];
    context?: ToolCallContext;
    onDone: (text: string, completionChars: number, toolCalls: ReturnType<typeof toOpenAiToolCalls>) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  },
  ctx: ExecutionContext
): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input, ctx);
}

function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    metadata?: Record<string, unknown>;
    tools: OpenAiToolSpec[];
    context?: ToolCallContext;
    onDone: (text: string, completionChars: number, toolCalls: ReturnType<typeof toOpenAiToolCalls>) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  },
  ctx: ExecutionContext
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    try {
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
            }
            await writer.write(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } }));
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) await writer.write(chunk);
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          text = event.finalText;
        }
      }

      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(text, streamedToolCalls);
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writer.write(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars
            })
          );
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0
        })) await writer.write(event);
      }
      await input.onDone(text, completionCharsFromOutput(text, streamedToolCalls), streamedToolCalls);
    } catch (error) {
      await input.onError(error);
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer.write(encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error"));
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  ctx.waitUntil(pump());
  return sseResponse(readable);
}

function sessionAffinity(request: Request): string | undefined {
  return (
    request.headers.get("x-session-affinity") ||
    request.headers.get("x-opencode-session-id") ||
    request.headers.get("x-opencode-session")
  )?.trim() || undefined;
}

async function handleResponseStateRoute(request: Request, auth: AuthResult, route: OpenAiRoute): Promise<Response> {
  if (!route.responseId) return notFound();
  const ownerKey = await responseOwnerKey(auth);
  const state = getResponseState(ownerKey, route.responseId);
  if (!state) throw new HttpError("Response not found", 404, "not_found");

  if (route.kind === "response") {
    if (request.method === "GET" || request.method === "HEAD") {
      if (!state.response) throw new HttpError("Response not found", 404, "not_found");
      return json(state.response);
    }
    if (request.method === "DELETE") {
      responseState.delete(responseStateKey(ownerKey, route.responseId));
      return json({ id: route.responseId, object: "response", deleted: true });
    }
    return notFound();
  }

  if (route.kind === "responseInputItems") {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    if (!state.response) throw new HttpError("Response not found", 404, "not_found");
    return json(responseInputItemsObject(state.inputItems));
  }

  if (route.kind === "responseCancel") {
    if (request.method !== "POST") return notFound();
    throw new HttpError("Only background responses can be cancelled. API for Cursor runs responses synchronously.", 400, "invalid_request_error");
  }

  return notFound();
}

function previousResponseIdFromBody(body: unknown): string | undefined {
  if (!isRecordLike(body)) return undefined;
  const value = body.previous_response_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function responseOwnerKey(auth: AuthResult): Promise<string> {
  return `direct:${(await sha256Hex(auth.cursorApiKey)).slice(0, 24)}`;
}

function getResponseState(ownerKey: string, responseId: string): StoredResponseState | undefined {
  return responseState.get(responseStateKey(ownerKey, responseId));
}

function storeResponseState(
  ownerKey: string,
  input: {
    id: string;
    response: Record<string, unknown>;
    inputItems: unknown[];
    outputItems: unknown[];
    store: boolean;
    sdkSessionKey?: string;
    now: number;
  }
) {
  const key = responseStateKey(ownerKey, input.id);
  responseState.set(key, {
    ownerKey,
    id: input.id,
    response: input.store ? input.response : undefined,
    inputItems: input.store ? input.inputItems : [],
    outputItems: input.outputItems,
    sdkSessionKey: input.sdkSessionKey,
    updatedAt: input.now
  });
  pruneResponseState();
}

function responseStateKey(ownerKey: string, responseId: string): string {
  return `${ownerKey}:${responseId}`;
}

function pruneResponseState() {
  if (responseState.size <= RESPONSE_STATE_LIMIT) return;
  const entries = [...responseState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, responseState.size - RESPONSE_STATE_LIMIT)) {
    responseState.delete(key);
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function authenticate(request: Request): AuthResult | null {
  const token = bearerToken(request);
  return token ? { cursorApiKey: token } : null;
}

interface OpenAiRoute {
  kind: "chat" | "responses" | "models" | "response" | "responseInputItems" | "responseCancel";
  responseId?: string;
  surface?: "standard" | "opencodev2";
}

type CompletionRoute = OpenAiRoute & { kind: "chat" | "responses" };

function matchOpenAiRoute(pathname: string): OpenAiRoute | null {
  const opencodeV2Path = pathname.startsWith("/opencodev2/v1/") ? pathname.slice("/opencodev2/v1".length) : "";
  if (opencodeV2Path === "/chat/completions") return { kind: "chat", surface: "opencodev2" };
  if (opencodeV2Path === "/models") return { kind: "models", surface: "opencodev2" };

  const path = pathname.startsWith("/v1/") ? pathname.slice(3) : "";
  if (path === "/chat/completions") return { kind: "chat" };
  if (path === "/responses") return { kind: "responses" };
  const responseInputItemsMatch = /^\/responses\/([^/]+)\/input_items\/?$/.exec(path);
  if (responseInputItemsMatch) return { kind: "responseInputItems", responseId: responseInputItemsMatch[1] };
  const responseCancelMatch = /^\/responses\/([^/]+)\/cancel\/?$/.exec(path);
  if (responseCancelMatch) return { kind: "responseCancel", responseId: responseCancelMatch[1] };
  const responseMatch = /^\/responses\/([^/]+)\/?$/.exec(path);
  if (responseMatch) return { kind: "response", responseId: responseMatch[1] };
  if (path === "/models") return { kind: "models" };
  return null;
}

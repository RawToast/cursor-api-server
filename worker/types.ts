export interface Env {
  CURSOR_API_BASE?: string;
  CURSOR_BACKEND_BASE_URL?: string;
  CURSOR_CHAT_ENDPOINT?: string;
  CURSOR_CLIENT_VERSION?: string;
  CURSOR_LOCAL_AGENT_ENDPOINT?: string;
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_BRIDGE_URL?: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Deps {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

export interface CursorMe {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

export type CursorImage =
  | { url: string; dimension?: { width: number; height: number }; uuid?: string }
  | { data: string; mimeType: string; dimension?: { width: number; height: number }; uuid?: string };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CursorCompletion {
  requestId: string;
  conversationId: string;
  stream: Response;
}

export interface CompletionResult {
  id: string;
  model: string;
  created: number;
  text: string;
  promptChars: number;
  completionChars: number;
  cursorAgentId?: string;
  cursorRunId?: string;
}

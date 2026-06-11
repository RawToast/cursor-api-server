# API for Cursor

A local OpenAI-compatible `/v1` server backed by Cursor Composer. One Bun process, no cloud, no app — your Cursor API key goes straight through as the Bearer token and nothing is stored.

## Quickstart

```bash
bun install
bun run server
```

The server listens on `http://127.0.0.1:8787/v1` and starts the Cursor SDK bridge automatically. Get a Cursor user API key from the Cursor Dashboard under Integrations and use it as the Bearer token; do not commit it to source control.

> **Note:** the bridge runs as a Node subprocess (auto-detected, auto-restarted). The Cursor SDK speaks gRPC over `node:http2`, which Bun's http2 client cannot handle yet (`NGHTTP2_FRAME_SIZE_ERROR`), so Node is required alongside Bun. Override the binary with `CURSOR_SDK_BRIDGE_RUNTIME=/path/to/node`.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

```ts
import OpenAI from "openai"

const client = new OpenAI({
  apiKey: process.env.CURSOR_API_KEY,
  baseURL: "http://127.0.0.1:8787/v1",
})

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Write a TypeScript debounce." }],
})
```

## Endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`, plus `GET /v1/responses/{id}`, `GET /v1/responses/{id}/input_items`, `POST /v1/responses/{id}/cancel`, `DELETE /v1/responses/{id}`
- `GET /v1/models`
- `/opencodev2/v1/*` — alias surface for the OpenCode provider (adds the SDK harness model labels)
- `GET /health`

Response state and SDK sessions are held in memory; restarting the server invalidates `previous_response_id` continuations by design.

## Configuration

All settings are optional environment variables (Bun auto-loads `.env`; see `.env.example`):

| Variable                                              | Default                  | Purpose                                                                              |
| ----------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `PORT` / `HOST`                                       | `8787` / `127.0.0.1`     | API listen address                                                                   |
| `CURSOR_API_BASE`                                     | `https://api.cursor.com` | Cursor public API                                                                    |
| `CURSOR_SDK_BRIDGE_PORT`                              | `8792`                   | SDK bridge subprocess port                                                           |
| `CURSOR_SDK_BRIDGE_RUNTIME`                           | auto-detected `node`     | Binary used to run the bridge subprocess                                             |
| `CURSOR_SDK_BRIDGE_URL`                               | unset                    | Use an external bridge instead of starting one (pair with `CURSOR_SDK_BRIDGE_TOKEN`) |
| `CURSOR_SDK_BRIDGE_TIMEOUT_MS`                        | `180000`                 | Bridge request timeout                                                               |
| `CURSOR_CLIENT_VERSION` / `CURSOR_SDK_CLIENT_VERSION` | `2.6.22` / `sdk-1.0.13`  | Version strings sent to Cursor                                                       |

### Legacy direct-backend fallback

By default all completions run through the Cursor SDK bridge. Setting `CURSOR_FORCE_LEGACY_BACKEND=1` skips the bridge and talks to Cursor's chat backend directly; this requires `CURSOR_BACKEND_BASE_URL` and `CURSOR_CHAT_ENDPOINT`, whose values are private — never commit them.

## Compatibility notes

This project supports text and image input, non-streaming and streaming output, JSON-output prompt constraints, and the common SDK response shapes. Image inputs can be sent as Chat Completions `image_url` parts or Responses `input_image` parts; each resolved image must be 1MB or smaller.

These OpenAI features are intentionally rejected because Cursor does not expose equivalent OpenAI controls through this path:

- `n` greater than `1`
- `logprobs` and `top_logprobs`
- audio output
- background Responses API jobs

Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path. For Composer 2.5 and Composer 2.5 Fast, `usage.cost` is estimated from Cursor's published per-million-token pricing.

## Development

```bash
bun run test       # vitest
bun run typecheck  # tsc --noEmit
```

The SDK bridge can also run standalone with `node scripts/cursor-sdk-local-agent-bridge.mjs` (listens on `127.0.0.1:8792`).

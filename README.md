# API for Cursor

OpenAI-compatible `chat.completions` and `responses` endpoints backed by Cursor Composer.

Live deployment: https://cursor-api.standardagents.ai

## What this is

Cursor does not expose Composer 2.5 as a raw OpenAI-compatible model endpoint. API for Cursor adapts OpenAI-style requests into the format Cursor accepts:

- `POST /auth/exchange_user_api_key`
- a private Cursor chat endpoint configured with `CURSOR_CHAT_ENDPOINT`
- a private Cursor local SDK endpoint configured with `CURSOR_LOCAL_AGENT_ENDPOINT`

Each generic `/v1` request is stateless from the caller's perspective: the Worker creates a fresh request/conversation id, sends the full prompt, streams text back, and does not create a hosted agent. The recommended OpenCode route is `/opencodev2/v1`: it uses a small SDK-compatible local-agent harness, so OpenCode owns the local filesystem and shell tool loop while SDK tool-call events are translated back into OpenAI-compatible `tool_calls`. The legacy `/opencode/v1` route remains available for the older Cursor chat-endpoint behavior.

## Supported endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`

## Usage

Point any OpenAI-compatible client at the base URL and authenticate with your own
Cursor API key as the bearer token. The key is forwarded to Cursor per request and
is **not stored**: no signup, no encrypted-at-rest secret, no request logs.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CURSOR_API_KEY, // your Cursor user API key
  baseURL: "https://<deployment>/v1"
});

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Write a TypeScript debounce." }]
});
```

```bash
curl https://<deployment>/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

A Cursor user API key comes from the Cursor Dashboard under Integrations.

To keep the key available in every new terminal, add it to your shell profile:

```bash
# zsh, the default shell on modern macOS
printf '\nexport CURSOR_API_KEY="crsr_..."\n' >> ~/.zshrc
source ~/.zshrc

# bash
printf '\nexport CURSOR_API_KEY="crsr_..."\n' >> ~/.bashrc
source ~/.bashrc
```

For fish:

```fish
set -Ux CURSOR_API_KEY "crsr_..."
```

Do not commit your Cursor API key. Use your shell profile, your deployment provider's secret manager, or a local `.env` file ignored by git.

## Legacy hosted-key flow (optional)

The Worker also keeps a backward-compatible hosted-key flow: `POST /api/signup`
verifies a Cursor API key, stores it encrypted in D1, and mints a separate
`cmp_...` proxy key usable against per-account endpoints at
`/u/{account_id}/v1/...`. This flow is optional; the direct Bearer usage above
is the recommended path. A `cmp_...` token is always resolved against D1 and is
never forwarded to Cursor as a Cursor key.

## Compatibility notes

This project supports text and image input, non-streaming and streaming output, JSON-output prompt constraints, and the common SDK response shapes. Image inputs can be sent as Chat Completions `image_url` parts or Responses `input_image` parts; each resolved image must be 1MB or smaller.

These OpenAI features are intentionally rejected because Cursor does not expose equivalent OpenAI controls through this path:

- `n` greater than `1`
- `logprobs` and `top_logprobs`
- audio output
- OpenAI function/tool calls on the Responses API
- background Responses API jobs

Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path. For Composer 2.5 and Composer 2.5 Fast, `usage.cost` is estimated from Cursor's published per-million-token pricing.

## OpenCode

![Composer 2.5 in OpenCode](public/opencode-composer-2-5.webp)

OpenCode should use a hosted OpenCode route, not the generic `/v1` route. The
main OpenCode integration is the SDK-compatible local-agent harness at
`/opencodev2/v1`. It does not create Cursor cloud agents; it mirrors the SDK's
local-agent protocol and forwards local filesystem and shell execution back to
OpenCode.

Base URL:

```txt
https://cursor-api.standardagents.ai/opencodev2/v1
```

OpenCode uses these endpoints:

- `GET /opencodev2/v1/models`
- `POST /opencodev2/v1/chat/completions`

Configure OpenCode with `@ai-sdk/openai-compatible` and select
`cursorsdk/composer-2.5-sdk`, displayed as **Composer 2.5 SDK Harness**.

For session affinity, the Worker stores only hashed owner/session keys and the
local SDK agent id; it does not store the caller's Cursor API key. Cloudflare
Workers do not currently provide a functional `node:http2` client, so production
SDK runs use a tiny JavaScript bridge in `scripts/cursor-sdk-opencode-bridge.mjs`.
The bridge can run on Bun or Node, owns only the HTTP/2 transport, and does not
execute local filesystem tools. In the deployed Worker this runs as a shared
Cloudflare Container behind the `CURSOR_SDK_BRIDGE_CONTAINER` Durable Object
binding.

<details>
<summary>Use the old /opencode/v1 route</summary>

The old `/opencode/v1` route keeps the previous Cursor chat-endpoint behavior:
the Worker forces Agent mode, keeps the conversation id stable for OpenCode's
session-affinity header, and translates Cursor tool-call output into
OpenAI-compatible `tool_calls`.

Base URL:

```txt
https://cursor-api.standardagents.ai/opencode/v1
```

Old-route endpoints:

- `GET /opencode/v1/models`
- `POST /opencode/v1/chat/completions`

Select `cursor/composer-2.5`, displayed as **Composer 2.5**.

</details>

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Create a local `.dev.vars` file:

```bash
ENCRYPTION_KEY="replace-with-a-long-random-secret"
WAITLIST_API_TOKEN="optional-standard-agents-waitlist-token"
CURSOR_BACKEND_BASE_URL="private-cursor-backend-origin"
CURSOR_CHAT_ENDPOINT="private-cursor-chat-endpoint"
CURSOR_LOCAL_AGENT_ENDPOINT="private-cursor-local-sdk-agent-endpoint"
CURSOR_SDK_BRIDGE_URL="optional-external-node-sdk-bridge-url"
CURSOR_SDK_BRIDGE_TOKEN="optional-external-shared-bridge-token"
CURSOR_CLIENT_VERSION="2.6.22"
CURSOR_SDK_CLIENT_VERSION="sdk-1.0.13"
```

Run the optional SDK HTTP/2 bridge in a local Bun or Node environment:

```bash
npm run sdk:opencode-bridge
```

## Cloudflare

The Worker uses Cloudflare Vite and D1.

Remote migration and deploy commands require a valid `CLOUDFLARE_API_TOKEN` in
the shell environment.

```bash
npm run build
npm run test
npm run typecheck
npm run db:migrate:remote
npm run deploy
```

Required secrets:

```bash
wrangler secret put ENCRYPTION_KEY
wrangler secret put CURSOR_BACKEND_BASE_URL
wrangler secret put CURSOR_CHAT_ENDPOINT
wrangler secret put CURSOR_LOCAL_AGENT_ENDPOINT
```

The OpenCode SDK harness also requires the `0002_sdk_sessions.sql` migration so
local SDK agent ids can be resumed across Worker isolates.

The Cloudflare deployment uses the container-backed bridge by default. Do not set
`CURSOR_SDK_BRIDGE_URL` for that path. Only set it when intentionally routing the
SDK harness to an external Bun or Node bridge instead of the
`CURSOR_SDK_BRIDGE_CONTAINER` Durable Object binding.

Optional SDK harness overrides:

```bash
wrangler secret put CURSOR_SDK_CLIENT_VERSION
wrangler secret put CURSOR_SDK_BRIDGE_URL
wrangler secret put CURSOR_SDK_BRIDGE_TOKEN
```

Optional secret for direct waitlist writes. If omitted, the Worker falls back to the deployed token-cost early-access endpoint.

```bash
wrangler secret put WAITLIST_API_TOKEN
```

## Research sources

- Cursor SDK package: `@cursor/sdk@1.0.13`
- Cursor SDK TypeScript docs: https://cursor.com/docs/api/sdk/typescript
- Cursor Composer 2.5 changelog: https://cursor.com/changelog/composer-2-5
- OpenAI Chat Completions reference: https://developers.openai.com/api/docs/api-reference/chat
- OpenAI Responses reference: https://developers.openai.com/api/docs/api-reference/responses
- OpenAI migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses
- Cloudflare Containers getting started: https://developers.cloudflare.com/containers/get-started/
- Cloudflare Containers container class: https://developers.cloudflare.com/containers/container-class/

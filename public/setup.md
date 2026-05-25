# How to use it

Cursor does not expose a standard inference API. This proxy accepts familiar OpenAI-style requests and transforms the formats into something Cursor can use.

Use the OpenAI SDK, Vercel AI SDK, or any client that can set a custom base URL. Authenticate every request with your Cursor API key as a Bearer token.

## Get a Cursor API key

Sign in at [cursor.com/dashboard](https://cursor.com/dashboard), open **Integrations -> API Keys**, and create a key. It should look like `crsr_...`.

This does not work around Cursor usage, billing, or account limits. You need a Cursor account and subscription to use this API, and every request is authenticated with your own Cursor API key.

## Set the key in your shell

Most SDKs and CLI tools read the key from `CURSOR_API_KEY`. For a one-time terminal session, run:

```bash
export CURSOR_API_KEY="crsr_..."
```

To make it available in every new terminal, add the export to your shell profile.

For zsh, the default shell on modern macOS:

```bash
printf '\nexport CURSOR_API_KEY="crsr_..."\n' >> ~/.zshrc
source ~/.zshrc
```

For bash:

```bash
printf '\nexport CURSOR_API_KEY="crsr_..."\n' >> ~/.bashrc
source ~/.bashrc
```

For fish:

```fish
set -Ux CURSOR_API_KEY "crsr_..."
```

Open a new terminal and check it is set:

```bash
echo "$CURSOR_API_KEY"
```

Do not put your Cursor API key in source control. Use your shell profile, your deployment provider's secret manager, or a local `.env` file that is ignored by git.

## Vercel AI SDK

Use the Vercel AI SDK when you want streaming helpers, framework adapters, and the `streamText` primitives you already use in Next.js or other TypeScript apps. Configure its OpenAI-compatible provider with this proxy as the base URL, then choose a Cursor-backed model id.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const openai = createOpenAI({
  apiKey: process.env.CURSOR_API_KEY,
  baseURL: "{{BASE_URL}}"
});

const result = streamText({
  model: openai.responses("composer-2.5"),
  prompt: "Explain async iterators."
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

## OpenAI SDK

Use the official OpenAI SDK when you want the broadest drop-in compatibility with existing Chat Completions or Responses code. The only required changes are the `baseURL`, the Bearer token, and the model id.

::: code-tabs

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CURSOR_API_KEY,
  baseURL: "{{BASE_URL}}"
});

const chat = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Explain async iterators." }]
});

console.log(chat.choices[0].message.content);

const response = await client.responses.create({
  model: "composer-2.5",
  input: "Explain async iterators."
});

console.log(response.output_text);
```

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["CURSOR_API_KEY"],
    base_url="{{BASE_URL}}",
)

chat = client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Explain async iterators."}],
)

print(chat.choices[0].message.content)

response = client.responses.create(
    model="composer-2.5",
    input="Explain async iterators.",
)

print(response.output_text)
```

:::

## OpenCode

![Composer 2.5 in OpenCode](/opencode-composer-2-5.webp)

OpenCode should use a hosted OpenCode route, not the generic `/v1` route. The recommended route is the SDK-compatible local-agent harness at `/opencodev2/v1`. It does not create Cursor cloud agents; it mirrors the SDK's local-agent protocol and forwards local filesystem and shell execution back to OpenCode.

Streaming requests return the final OpenAI-style usage chunk when OpenCode asks for usage. Token counts are estimated from the prompt and output text, and the displayed cost uses Cursor's published Composer 2.5 standard rate.

The OpenCode base URL is:

```txt
https://cursor-api.standardagents.ai/opencodev2/v1
```

OpenCode will use these endpoints:

- `GET /opencodev2/v1/models`
- `POST /opencodev2/v1/chat/completions`

Add a custom provider to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "cursorsdk/composer-2.5-sdk",
  "provider": {
    "cursorsdk": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor SDK Bridge",
      "options": {
        "baseURL": "https://cursor-api.standardagents.ai/opencodev2/v1",
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5-sdk": {
          "name": "Composer 2.5 SDK Harness",
          "cost": {
            "input": 0.5,
            "output": 2.5
          },
          "limit": {
            "context": 200000,
            "output": 65536
          }
        }
      }
    }
  }
}
```

Then start OpenCode with your Cursor API key in the environment:

```bash
export CURSOR_API_KEY="crsr_..."
opencode
```

Choose `cursorsdk/composer-2.5-sdk`, displayed as **Composer 2.5 SDK Harness**.

::: details Use the old v1 OpenCode route

The old `/opencode/v1` route keeps the previous Cursor chat-endpoint behavior: the proxy forces Agent mode, keeps the conversation id stable for OpenCode's session-affinity header, and translates Cursor tool-call output into OpenAI-compatible `tool_calls`.

Old route base URL:

```txt
https://cursor-api.standardagents.ai/opencode/v1
```

Old route endpoints:

- `GET /opencode/v1/models`
- `POST /opencode/v1/chat/completions`

To use it, point your provider at `/opencode/v1` and choose `cursor/composer-2.5`, displayed as **Composer 2.5**.

:::

## Native macOS app

CursorAPI also has a native macOS app for a fully local LM Studio-style setup.
The app listens on loopback, exposes `/v1/models`, `/v1/chat/completions`, and
`/v1/responses`, and does the SDK-compatible HTTP/2 transport itself instead of
calling the hosted Cloudflare API.

The app stores the Cursor API key in macOS Keychain and writes `cursor-local`
placeholders into agent configs, so OpenCode, Codex, VS Code, Cline, Kilo Code,
and pi do not need a real Cursor key written to disk.

The local API stays stopped until both the Cursor API key and SDK transport are
configured. Once configured, use the app's Check SDK action to verify key
exchange and HTTP/2 transport before pointing coding agents at it.

For a double-clickable team build, package the app with local SDK transport
defaults in the packager environment:

```bash
CURSOR_BACKEND_BASE_URL="..." \
CURSOR_LOCAL_AGENT_ENDPOINT="..." \
CURSOR_SDK_CLIENT_VERSION="sdk-1.0.13" \
macos/CursorAPI/Scripts/package-app.sh
```

Those private transport values are embedded only into the generated `.app`
bundle and are not committed to source control.

## cURL

```bash
curl {{BASE_URL}}/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{ "role": "user", "content": "hello world" }],
    "stream": true
  }'
```

## Custom client

Set your base URL to:

```txt
{{BASE_URL}}
```

Send your Cursor key as the Authorization header:

```http
Authorization: Bearer <your-cursor-api-key>
```

Available endpoints:

- `POST {{BASE_URL}}/chat/completions`
- `POST {{BASE_URL}}/responses`
- `GET {{BASE_URL}}/models`

## Try it in Cursor Chat

Open [Cursor Chat](/chat) to try an example app that uses the missing API to create a ChatGPT-style experience with Cursor models. It sends the same `/v1/chat/completions` requests shown above and displays the request JSON beside the conversation.

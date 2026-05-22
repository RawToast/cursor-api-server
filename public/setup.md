# How to use it

Cursor does not expose a standard inference API. This proxy accepts familiar OpenAI-style requests and transforms the formats into something Cursor can use.

Use the OpenAI SDK, Vercel AI SDK, or any client that can set a custom base URL. Authenticate every request with your Cursor API key as a Bearer token.

## Get a Cursor API key

Sign in at [cursor.com/dashboard](https://cursor.com/dashboard), open **Integrations -> API Keys**, and create a key. It should look like `crsr_...`.

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

OpenCode supports custom OpenAI-compatible providers through `@ai-sdk/openai-compatible`, so you can point it at this proxy and use your Cursor API key as the provider key.

Add a custom provider to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "cursor/composer-2.5",
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor",
      "options": {
        "baseURL": "{{BASE_URL}}",
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5"
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

If you do not set `model`, run `/models` inside OpenCode and choose `cursor/composer-2.5`.

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

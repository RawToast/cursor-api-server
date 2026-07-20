import { handleRequest } from "./worker/index"
import type { Env, ExecutionContext } from "./worker/types"

const port = Number(process.env.PORT || 8787)
const hostname = process.env.HOST || "127.0.0.1"
const bridgeScript = new URL("./scripts/cursor-sdk-local-agent-bridge.mjs", import.meta.url)
  .pathname

interface BridgeSetup {
  bridgeUrl?: string
  close?: () => void
  mode: string
}

async function startBridge(): Promise<BridgeSetup> {
  if (process.env.CURSOR_FORCE_LEGACY_BACKEND === "1") {
    if (!process.env.CURSOR_BACKEND_BASE_URL?.trim() || !process.env.CURSOR_CHAT_ENDPOINT?.trim()) {
      console.warn(
        "CURSOR_FORCE_LEGACY_BACKEND=1 requires CURSOR_BACKEND_BASE_URL and CURSOR_CHAT_ENDPOINT; /v1 completions will fail until both are set.",
      )
    }
    return { mode: "legacy direct backend" }
  }

  const externalBridgeUrl = process.env.CURSOR_SDK_BRIDGE_URL?.trim()
  if (externalBridgeUrl) {
    return { bridgeUrl: externalBridgeUrl, mode: `external SDK bridge at ${externalBridgeUrl}` }
  }

  // The bridge reads these from process.env at startup (in-process: at import
  // time; subprocess: inherited), so they must be set before either path runs.
  process.env.CURSOR_SDK_BRIDGE_HOST ||= "127.0.0.1"
  process.env.CURSOR_SDK_BRIDGE_PORT ||= "8792"
  process.env.CURSOR_SDK_BRIDGE_TOKEN ||= crypto.randomUUID()
  const bridgeHost = process.env.CURSOR_SDK_BRIDGE_HOST
  const bridgePort = process.env.CURSOR_SDK_BRIDGE_PORT
  const bridgeUrl = `http://${bridgeHost}:${bridgePort}/sdk`

  // The Cursor SDK speaks gRPC over node:http2, which Bun's http2 client cannot
  // handle yet (NGHTTP2_FRAME_SIZE_ERROR). Run the bridge under Node when
  // available; fall back to in-process Bun only as a last resort.
  const runtime = process.env.CURSOR_SDK_BRIDGE_RUNTIME?.trim() || Bun.which("node")
  if (runtime) {
    const close = spawnBridgeSubprocess(runtime)
    await waitForBridgeHealth(`http://${bridgeHost}:${bridgePort}/health`)
    return { bridgeUrl, close, mode: `SDK bridge subprocess (${runtime})` }
  }

  console.warn(
    "Node was not found; running the SDK bridge in-process under Bun. Cursor SDK calls are known to fail with NGHTTP2_FRAME_SIZE_ERROR on Bun's node:http2 client — install Node or set CURSOR_SDK_BRIDGE_RUNTIME to a Node binary.",
  )
  const bridge = await import("./scripts/cursor-sdk-local-agent-bridge.mjs")
  const bridgeServer = bridge.startServer()
  await new Promise<void>((resolve, reject) => {
    bridgeServer.once("listening", resolve)
    bridgeServer.once("error", (error) =>
      reject(new Error(`Could not start the SDK bridge on port ${bridgePort}: ${error.message}`)),
    )
  })
  return { bridgeUrl, close: () => void bridgeServer.close(), mode: "in-process SDK bridge" }
}

type SpawnedProcess = ReturnType<typeof Bun.spawn>
function spawnBridgeSubprocess(runtime: string): () => void {
  let stopped = false
  const bridgeHost = process.env.CURSOR_SDK_BRIDGE_HOST || "127.0.0.1"
  const bridgePort = process.env.CURSOR_SDK_BRIDGE_PORT || "8792"
  const healthUrl = `http://${bridgeHost}:${bridgePort}/health`
  const spawnChild = (): SpawnedProcess =>
    Bun.spawn([runtime, bridgeScript], { stdout: "inherit", stderr: "inherit" })

  let child = spawnChild()

  function superviseExit(proc: SpawnedProcess): void {
    void proc.exited.then(async (code) => {
      if (stopped) return
      console.error(`SDK bridge exited with code ${code}; restarting in 1s.`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (stopped) return
      child = spawnChild()
      superviseExit(child)
      try {
        await waitForBridgeHealth(healthUrl)
        console.error("SDK bridge restarted and is healthy.")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`SDK bridge failed to become healthy after restart: ${message}`)
      }
    })
  }
  superviseExit(child)

  return () => {
    stopped = true
    child.kill()
  }
}

async function waitForBridgeHealth(healthUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) return
    } catch {
      // Bridge not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`SDK bridge did not become healthy at ${healthUrl} within 15s`)
}

const bridge = await startBridge()

const env: Env = {
  CURSOR_API_BASE: process.env.CURSOR_API_BASE,
  CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL,
  CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
  CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION,
  CURSOR_LOCAL_AGENT_ENDPOINT: process.env.CURSOR_LOCAL_AGENT_ENDPOINT,
  CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_TIMEOUT_MS,
  CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
  CURSOR_SDK_BRIDGE_URL: bridge.bridgeUrl,
  CURSOR_SDK_CLIENT_VERSION: process.env.CURSOR_SDK_CLIENT_VERSION,
}

const ctx: ExecutionContext = {
  waitUntil(promise) {
    void promise.catch(() => undefined)
  },
}

const server = Bun.serve({
  port,
  hostname,
  // SSE completions can stream for minutes; never let Bun idle-close them.
  idleTimeout: 0,
  fetch: (request) => handleRequest(request, env, ctx),
})

console.log(`API for Cursor listening on http://${hostname}:${port}/v1 (${bridge.mode})`)

function shutdown() {
  server.stop(true)
  bridge.close?.()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

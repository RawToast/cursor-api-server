export interface BridgeServer {
  once(event: "listening", listener: () => void): BridgeServer
  once(event: "error", listener: (error: Error) => void): BridgeServer
  close(callback?: () => void): BridgeServer
}

export function startServer(): BridgeServer

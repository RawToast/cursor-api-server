import type { ExecutionContext } from "./types"

export function fakeCtx(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined)
    },
  }
}

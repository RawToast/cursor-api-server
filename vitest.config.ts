import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 10000
  }
});

import { defineConfig } from "vitest/config"

// Standalone vitest config — deliberately does NOT extend vite.config.ts
// (whose @cloudflare/vite-plugin + TanStack Start plugins target the Workers
// build and break the node-pool test server). Node-pool unit tests only:
// pure TS helpers like lib/safeUrl. Anything needing the Workers runtime
// belongs in packages/hono-worker or the e2e suite.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
})

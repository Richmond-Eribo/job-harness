import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Vitest 4: `poolOptions.threads.singleThread` was flattened to top-level
    // `fileParallelism: false` (single file at a time).
    fileParallelism: false,
    include: ["src/test/**/*.test.ts"],
    // The workers-pool integration tests import `cloudflare:test`, which the
    // node pool can't resolve. They run via vitest.workers.config.ts instead.
    exclude: ["src/test/integration/**", "node_modules", "dist"],
    globals: true,
  },
})

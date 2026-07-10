import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Vitest 4: `poolOptions.threads.singleThread` was flattened to top-level
    // `fileParallelism: false` (single file at a time).
    fileParallelism: false,
    include: ["src/test/**/*.test.ts"],
    globals: true,
  },
})

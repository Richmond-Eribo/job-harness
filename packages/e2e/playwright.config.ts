import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { E2E_WEB_URL } from "./fixtures/env"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..")

/**
 * Playwright config for the agent-harness E2E suite.
 *
 * Two live origins are exercised:
 *   - frontend (TanStack Start / Vite) on http://localhost:5173
 *   - API worker (Hono / wrangler dev) on http://localhost:8787
 * Both are brought up by `npm run dev` at the repo root (via concurrently).
 *
 * Single worker, no parallelism: the dev backend uses ONE shared local D1 + a
 * single global RateLimiter DO, so parallel specs would race. Files run
 * sequentially; tests within a file run sequentially too.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Browser-side specs are fast, but spec 04 starts a REAL agent run (~120s).
  // Give every test plenty of headroom.
  timeout: 60_000,
  // Single global timeout for the @llm run spec.
  globalTimeout: 10 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  // Suite-wide output dirs (gitignored).
  outputDir: "test-results",
  // Only run .spec.ts files. Spec ordering is filename-alphabetical — note the
  // numeric prefixes on the files, which give a deterministic, sensible order.
  // (Spec 08-traces depends on spec 04-dashboard-run having produced a run.)
  preserveOutput: "failures-only",

  use: {
    baseURL: E2E_WEB_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Sensible per-action timeout so failures surface quickly.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Bring up the whole project (both origins) before the suite. reuseExisting
  // means local devs can keep `npm run dev` running while iterating on tests.
  webServer: {
    command: "npm run dev",
    cwd: REPO_ROOT,
    url: E2E_WEB_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // wrangler dev + vite can take a while cold
    // The frontend reads VITE_API_URL at build time; make sure it's set when
    // Vite boots for the dev server.
    env: {
      ...process.env,
      VITE_API_URL: process.env.VITE_API_URL ?? "http://localhost:8787",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
})

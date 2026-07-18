import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"

// Integration-test config — runs tests INSIDE the Workers runtime via miniflare.
// Kept separate from vitest.config.ts (node pool) so the fast structural/unit
// tests and the heavier workers integration tests never collide.
//
// Bindings (D1, R2, AI, vars, and all five Durable Object namespaces + their
// SQLite migration tags) are inherited from wrangler.jsonc. DO SQLite
// migrations are applied automatically by miniflare; D1 migrations are NOT —
// applyD1Migrations() in the test helpers handles those per-test.
//
// Dev auth seam: RESEND_API_KEY / MAIL_FOR are left unset, so Better Auth's
// magic-link sendMagicLink callback logs the link and returns it as `devUrl`
// (src/auth/resend.ts) — no email provider needed. The helpers capture that
// URL from the console log to complete sign-in and grab the session cookie.
//
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN BLOCKER (Phase A.2 deferred — see src/test/integration/README.md)
// ─────────────────────────────────────────────────────────────────────────────
// pool-workers 0.18.x hits cloudflare/workers-sdk#6591 on this repo because
// the project path contains spaces ("agent on cloudflare"): workerd's fallback
// module resolver can't resolve the extensionless `require("./X")` calls in
// the worker's deep CJS dependency tree (cron-parser, ajv, @vercel/oidc,
// standardwebhooks, fast-uri, and the full transitive closure pulled by the
// agent DO classes). The modulesRules entries below fix several packages; the
// remainder surface faster than they can be enumerated.
//
// Confirmed-working alternatives if/when revisited:
//   1. Clone the repo to a path WITHOUT spaces — the standard Cloudflare
//      workaround per the #6591 thread; makes workerd's resolver behave.
//   2. Pre-bundle the worker with esbuild (scripts/bundle-test-worker.mjs)
//      and point `main` at the bundle — eliminates the resolver entirely.
//      Needs a CJS `module`/`exports` shim banner for packages like
//      fast-deep-equal that use bare `module.exports` in an ESM bundle.
//   3. The deps optimizer (test.deps.optimizer.ssr) fixes the requires but
//      runs WITHOUT nodejs_compat, so it can't bundle better-auth's
//      `node:crypto` variants.
//
// Until one of those lands, `npm run test:integration` will fail at worker
// instantiation with a location-less `SyntaxError`. The node-pool unit tests
// (`npm run test:unit`) are unaffected and stay green.
//
// NOTE: in pool-workers 0.18.x, `cloudflareTest(...)` is a Vite plugin that
// sets the vitest pool itself (MUST be a top-level plugin, not under
// `test.plugins`; Vitest 4 dropped `poolOptions`).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AUTH_SECRET: "test-auth-secret-do-not-use-in-prod",
          BETTER_AUTH_URL: "http://localhost:8787",
          LLM_API_KEY: "test-llm-key",
          // RESEND_API_KEY / MAIL_FROM intentionally OMITTED → dev magic-link.
        },
        // Fix the extensionless-require CJS packages confirmed on the worker
        // runtime path (each verified pure-CJS — ESM packages like
        // cron-schedule MUST NOT go here or they throw "Unexpected token
        // 'export'"). Add a package here when a test fails with:
        //   "No such module .../<pkg>/dist/<name>".
        modulesRules: [
          {
            type: "CommonJS",
            include: [
              "**/node_modules/cron-parser/dist/*",
              "**/node_modules/ajv/dist/*",
              "**/node_modules/ajv-formats/dist/*",
              "**/node_modules/standardwebhooks/dist/*",
              "**/node_modules/@vercel/oidc/dist/*",
              "**/node_modules/fast-uri/dist/*",
              "**/node_modules/qs/lib/*",
            ],
          },
        ],
      },
    }),
  ],
  test: {
    fileParallelism: false,
    include: ["src/test/integration/**/*.test.ts"],
    globals: true,
  },
})

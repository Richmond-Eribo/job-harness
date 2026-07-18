# Integration tests (workers pool)

These tests run the real Worker + D1 + Durable Objects + R2 inside the
Workers runtime via `@cloudflare/vitest-pool-workers`, driven through
`SELF.fetch` / `env` from `cloudflare:test`. Config lives in
[`vitest.workers.config.ts`](../../../vitest.workers.config.ts).

## Status: BLOCKED (Phase A.2 deferred)

The suite does not run yet. `npm run test:unit` (the node pool) is unaffected
and stays green; only `npm run test:integration` fails.

### Root cause

`cloudflare/workers-sdk#6591` — workerd's fallback module resolver cannot
resolve extensionless `require("./X")` calls when the project path contains
spaces. This repo lives at `…\agent on cloudflare` (space in the folder name),
so the resolver fails for the worker's deep CJS dependency tree
(`cron-parser`, `ajv`, `@vercel/oidc`, `standardwebhooks`, `fast-uri`, and the
full transitive closure pulled in by the agent Durable Object classes —
`harness.ts` alone reaches ~31 such packages).

### What works

- The pool boots and all bindings (`DB`, `CV_BUCKET`, `AI`, the five DO
  namespaces, vars) resolve correctly from `wrangler.jsonc`.
- `modulesRules: [{ type: "CommonJS", ... }]` fixes confirmed pure-CJS
  packages (see the config). Each entry was verified pure-CJS; ESM packages
  like `cron-schedule` must NOT be added (they throw
  `Unexpected token 'export'`).
- A trivial worker (`fetch: () => new Response("ok")`) passes end-to-end, so
  the pool itself, `cloudflare:test`, and `SELF.fetch` are all functional.

### What does not work

Instantiating the **real** worker entry (`src/index.ts`) — its agent DO
imports pull in CJS packages faster than they can be enumerated in
`modulesRules`. The failure is a location-less
`SyntaxError: Invalid or unexpected token` at suite load.

Tried and rejected:
- `ssr.noExternal` (array or `true`) — does not rewrite nested
  `require("./core")` during transform.
- `test.deps.optimizer.ssr` — fixes the requires via rolldown, but runs
  **without** `nodejs_compat`, so it fails to bundle `better-auth`'s
  `node:crypto` (`.node.mjs`) variants.
- esbuild pre-bundle + `main: "<bundle>"` — esbuild leaves bare
  `module.exports` statements (e.g. `fast-deep-equal`) in the ESM output,
  which is a SyntaxError under workerd. Fixable with a CJS shim banner, but
  edges into fragile custom-bundling territory.

### Path forward (pick one)

1. **Clone to a spaceless path** — the maintainers' own workaround in the
   #6591 thread. Cheapest; likely makes the standard pool config work.
2. **esbuild pre-bundle with a CJS shim** —
   `scripts/bundle-test-worker.mjs` → `node_modules/.cache/worker-bundled.mjs`,
   point `main` at it, add a banner providing `module`/`exports`. Eliminates
   the resolver entirely. Most robust long-term.
3. **Wait for a pool fix** — track #6591 / #14214.

## Planned suite (once unblocked)

Shared helpers — `helpers.ts`:

- `applyD1Migrations(env)` — apply `migrations/*.sql` to the per-test D1
  (pool does not auto-apply D1; DO SQLite migrations are automatic).
- `signUpAndAuth(email)` — POST `/api/auth/sign-in/magic-link`, capture the
  dev-mode link from the console log (resend.ts logs it when
  `RESEND_API_KEY`/`MAIL_FROM` are unset), GET it with `redirect: "manual"`
  to grab the session cookie. Returns `{ fetchAuthed }`.
- `onboard(fetchAuthed)` — POST `/api/onboarding` to flip `onboardingComplete`,
  lifting the 428 gate.
- `createJob`, `addJobSource`, `createSchedule` — thin builders.

Test files (mapped to features):

| File | Covers |
|---|---|
| `auth.test.ts` | magic-link sign-in → session cookie; `requireAuth` gate (401 JSON vs 302→/login; 428 vs 302→/onboarding); public-prefix passthrough; exact `/api/auth/sign-in/magic-link` path |
| `onboarding.test.ts` | `POST /api/onboarding` writes profile + flips flag; gated endpoints open after |
| `profile.test.ts` | `GET/PUT /api/profile`; CV upload to R2 (413 at >10 MB); round-trip; 404 |
| `jobs.test.ts` | create + dedupe (URL, company+title); pipeline; status enum; delete; follow-ups |
| `job-sources.test.ts` | `{query}` placeholder + valid baseUrl validation |
| `schedules.test.ts` | CRUD + toggle |
| `memory.test.ts` | `GET/PUT/DELETE /api/memory` + `/api/user-memory` |
| `goal-plan.test.ts` | `/api/goal`, `/api/plan`, `/api/plan/advance` |
| `extension-token.test.ts` | `POST /api/browser/extension-token` mints a cookie-authed token; verify round-trip |
| `multi-tenant.test.ts` | two users, isolated DO state; per-user `active-run` limit via the single global RateLimiter (`"global"`) |
| `runs-inspection.test.ts` | `/api/runs`, `/api/runs/:runId`, `…/events?sinceSeq=`, BOTH trace routes (`/api/run/:runId/trace` singular + `/api/runs/:runId`) |

### Known runtime bug this suite will catch

`POST /api/onboarding` (`src/index.ts`) writes
`UPDATE "user" SET onboarding_complete = 1, updated_at = …` — snake_case,
but `migrations/0002_camelcase.sql` defines those columns as `onboardingComplete`
/ `updatedAt`. Onboarding completion throws "no such column" at runtime. Fix:
use the camelCase column names in the UPDATE.

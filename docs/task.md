# Agent Harness — Task Tracker

## Phase 1: Project Setup

- [x] `package.json` with all dependencies
- [x] `tsconfig.json`
- [x] `.gitignore`
- [x] `.dev.vars` template

## Phase 2: Cloudflare Configuration

- [x] `wrangler.jsonc` (DOs, cron, vars) — **v1: free tier, no containers**
- [x] `Dockerfile` — **removed in v1** (free tier has no Containers); v2/paid
      variant would re-add it with the AgentSandbox DO.

## Phase 3: Shared Code

- [x] `src/types.ts` — Env, state interfaces, domain types
- [x] `src/llm.ts` — Model-agnostic LLM factory (BYOK)

## Phase 4: Sandbox

- [x] `src/sandbox.ts` — AgentSandbox with persistent disk

## Phase 5: Sub-Agents

- [x] `src/research-agent.ts` — ResearchAgent DO (AI Search + arXiv)
- [x] `src/job-agent.ts` — JobApplicationAgent DO (pipeline + cover letters)

## Phase 6: Harness (Core Brain)

- [x] `src/harness.ts` — Self-healing orchestration loop with tools

## Phase 7: Worker Entry Point

- [x] `src/index.ts` — fetch routes, scheduled watchdog, exports

## Phase 8: Dashboard

- [x] `src/dashboard.ts` — Full HTML dashboard (status, research, kanban,
      controls)

## Phase 9: Provisioning & DevOps

- [x] `scripts/setup.sh`
- [x] `.github/workflows/deploy.yml`

## Phase 10: Verification

- [x] npm install
- [x] TypeScript compiles (`npx tsc --noEmit`) — 0 errors
- [x] Fix type errors (callable→unstable_callable, .sql.exec→tagged-template
      sql``, getAgentByName generics+await, getSchedules rename, Sandbox
      binding)

## Phase 11: Anthropic-aligned agent re-architecture (in progress)

- [x] Harness is now a true **autonomous agent** (Anthropic "Building Effective
      Agents"): explicit visible while-loop (not buried in
      generateText({maxSteps})), LLM directs its own process, tools provide
      ground truth each step.
- [x] Removed the scripted "delegate research, then jobs, then finish" prompt
      (that was a workflow, not an agent).
- [x] Sub-agents reframed as **capability providers** the agent calls for real
      info, not competing decision-makers with their own LLM loops (still
      separate DOs so their state survives).
- [x] Stop conditions (Anthropic: "crucial to include"): maxSteps, tokenBudget
      (new), `finish` self-termination, idle detection (no tool for 2 turns),
      repeated-loop detection (same tool+args twice).
- [x] Layered memory: auto-run summary (always injected) + explicit
      `remember`/`recall` tools.
- [x] Tools renamed/redesigned as ACI: research, discover_jobs,
      write_cover_letter, pipeline_status, list_jobs, set_job_status,
      run_in_sandbox, remember, recall, finish.
- [x] tokenBudget + tokensUsed added to state + config surface.

## Phase 12: Grounding + capability modules (completed)

- [x] **searchJobs hallucination FIXED.** Replaced the LLM-with-only-`save_job`
      design (which fabricated listings) with a grounded 3-step pipeline: (1)
      `fetchJobListings()` fetches REAL listings from Arbeitnow + Remotive
      (no-auth, HTTPS, JSON); (2) the LLM only _ranks/scores_ the real listings
      (no tools, JSON output); (3) filter by score threshold + dedupe → persist.
      The LLM can no longer invent a company or URL — phantom idx values are
      dropped.
- [x] Graceful degradation: if ranking fails, a keyword-overlap fallback scores
      listings cheaply (replaces the old "save everything @ 0.5" behavior).
- [x] Added a second research source: Hacker News (Algolia, no-auth) alongside
      arXiv — ResearchAgent is no longer single-source.
- [x] **arXiv over HTTPS** (was `http://`), with `!res.ok` fail-soft (returns []
      instead of crashing the run).
- [x] Reviewed: research/jobs sub-agent LLM loops are now justified (research
      genuinely iterates search→assess; jobs is a single generateText with no
      agent loop). No unnecessary nested billing loops remain.
- [x] Verified end-to-end grounded data flow: Harness `discover_jobs` →
      `JobApplicationAgent.searchJobs` → real fetchers. `research` tool →
      `ResearchAgent.research` → arXiv + HN. Neither can fabricate.

## Phase 13: Hono router + free-tier (v1) split

- [x] **Removed the Cloudflare Container / Sandbox** entirely. The free Workers
      plan does not support Containers (needs $5/mo paid). Deleted
      `src/sandbox.ts` and `Dockerfile`; removed the `AgentSandbox` DO binding,
      the `containers` block, and the `v2` `new_classes` migration from
      `wrangler.jsonc`; removed `Sandbox` from the `Env` type; removed the
      `run_in_sandbox` tool + `getSandbox` import from the harness. The harness
      now draws ground truth from `research()` and `discover_jobs()` instead of
      shell execution.
- [x] **Rewrote `src/index.ts` on Hono.** Replaced the hand-rolled
      `if path === …` chain with a single `Hono<{ Bindings: Env }>` app: -
      `cors("*")` middleware on every route (preflight handled automatically). -
      Bearer-token auth middleware scoped to `/api/*` (dashboard at `/` stays
      public; token compared against `env.DASHBOARD_TOKEN`). - All ~25 API
      routes mapped 1:1 to typed Hono handlers (`app.get/post/put/delete`),
      using `c.req.param()` / `c.req.query()` / `c.req.json()` and returning
      `c.json(...)` / `c.html(...)`. - Dashboard served via
      `app.get("/", (c) => renderDashboard(c))`, rendered through Hono's
      `jsxRenderer` → `<Layout><Dashboard/></Layout>` (see Phase 15). No more
      inline-string HTML. - `fetch()` runs `app.fetch()` first, then falls back
      to `routeAgentRequest` for agent WebSocket upgrades, then 404. -
      `scheduled()` cron watchdog unchanged.
- [x] Installed `hono` via npm and uninstalled `@cloudflare/sandbox`.
- [x] Verified: `npx tsc --noEmit` → 0 errors; `npx wrangler deploy --dry-run`
      succeeds with bindings limited to 3 DOs + env vars (no paid features).

## Phase 15: Dashboard as Hono JSX views + static assets

- [x] **Deleted `src/dashboard.ts`** (the 1186-line inline string).
- [x] **Split into a proper view layer** following the Hono JSX idiom:
  - `src/views/Layout.tsx` — `<html><head>` shell + `<link>`/`<script>` to
    static assets. Exported `renderer` is a `jsxRenderer` middleware that wraps
    every `c.render(...)` in `<Layout>` and emits the doctype.
  - `src/views/Dashboard.tsx` — the `<body>` content as a typed `FC`.
  - `src/views/renderDashboard.tsx` — a `.tsx` helper that calls
    `c.render( <Dashboard/>)`, imported by `index.ts` (a `.ts` file, so it stays
    JSX-free).
- [x] **CSS + client JS → static assets** served by the Cloudflare `[assets]`
      binding: `public/css/dashboard.css`, `public/js/dashboard.js`. They cache
      independently and the HTML payload is tiny. The inline JS was unescaped
      (it was nested in a template literal before) so it's now valid standalone
      JS.
- [x] `tsconfig.json` updated: `jsxImportSource: "hono/jsx"`, `include` extended
      to `src/**/*.tsx`. (Note: JSX ships inside `hono` v4 itself — no separate
      `@hono/jsx` package.)
- [x] `app.use("*", renderer)` registered in `index.ts`; `c.json()`/`c.html()`
      routes still bypass the renderer.
- [x] `npx wrangler deploy --dry-run` confirms `env.ASSETS` binding + the 4
      asset files are picked up; `npx tsc --noEmit` → 0 errors.

## Versions

- **v1 (current, free tier)** — Durable Objects (SQLite-backed) + cron only. No
  Sandbox, no code execution. This is what's deployed.
- **v2 (paid tier, not built)** — would re-add the `AgentSandbox` container DO
  (`@cloudflare/sandbox`) + Dockerfile + `containers`/`new_classes` migration,
  and restore a `run_in_sandbox` tool to the harness for shell execution.

## Phase 14 (remaining, non-blocking)

- [ ] pause()/resume()/stop() short-circuit between steps; mid-step calls still
      wait for the current LLM turn (~seconds).
- [ ] Dashboard provider switch is an intentional no-op (redeploy needed).
- [ ] Consider `generateObject` (zod) for job ranking JSON instead of manual
      parse.

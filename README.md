<div align="center">

# 🤖 Agent Harness

**An autonomous, self-healing agent that runs on a schedule — on Cloudflare's
free tier.**

It researches AI trends and works through a job-application pipeline entirely on
its own, with a dashboard to watch and steer it.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vercel AI SDK](https://img.shields.io/badge/AI_SDK-Vercel-000000?logo=vercel&logoColor=white)](https://sdk.vercel.ai/)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002)](https://hono.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Features](#-features) · [How it works](#-how-it-works) ·
[Quick start](#-quick-start) · [Configuration](#-configuration) · [API](#-api) ·
[Project structure](#-project-structure)

</div>

---

> The architecture follows Anthropic's
> ["Building Effective Agents"](https://www.anthropic.com/research/building-effective-agents)
> guidance: an explicit visible agent loop, tools that provide **ground truth
> from the environment** at each step, and clear stopping conditions.
>
> Built with the Cloudflare
> [`agents`](https://developers.cloudflare.com/agents/) SDK, Durable Objects
> (SQLite-backed), a cron-based self-healing watchdog, and the Vercel AI SDK
> (BYOK — bring your own key, Anthropic or OpenAI).

## 📑 Table of contents

- [Features](#-features)
- [How it works](#-how-it-works)
- [Quick start](#-quick-start)
- [Configuration](#-configuration)
- [API](#-api)
- [Project structure](#-project-structure)
- [Tech stack](#-tech-stack)
- [Safety & cost controls](#-safety--cost-controls)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

- **True autonomous agent** — not a scripted workflow. An LLM plans every run,
  observes tool results, and decides the next action until the goal is met.
- **Self-healing** — a 2-minute cron watchdog checks if any schedule is due and
  starts a run automatically. Missed windows are caught up.
- **Grounded, never hallucinated** — jobs come from real API feeds (Arbeitnow,
  Remotive); research comes from real sources (arXiv, Hacker News). The LLM only
  ranks and summarizes real data.
- **Two memory layers** —
  - **Agent memory** (the `context` table): facts the agent itself recalls /
    remembers via `remember` / `recall` tools.
  - **User memory** (the `user_memory` table): operator-authored notes injected
    into every system prompt as higher-authority guidance.
- **Full observability** — every run emits a structured trace event stream
  (`run_start`, `system`, `prompt`, `reasoning`, `text`, `tool_call`,
  `tool_result`, `step_end`, `run_end`) to the `trace_events` SQLite table, with
  live-poll and per-day / per-turn token breakdowns surfaced on the dashboard.
- **Schedules via full cron** — ranges, steps, lists, named days. Powered by
  `cron-parser` (no failing hand-rolled matchers).
- **Cost-bounded** — hard stops on `maxSteps`, idle detection, and
  repeated-loop detection. A token budget exists but **defaults to 0
  (unlimited)** — set it from the dashboard before trusting long runs.
- **Multi-page dashboard** — server-rendered JSX pages for **Overview, Jobs,
  Traces, Logs, Memory,** and **Settings**, plus a structured-plan view and a
  goal editor.
- **Model-agnostic** — Anthropic Claude **or** OpenAI GPT, configured via env
  vars and `src/llm-config.json` (baked at build time — see [Model config](#model-config)).
- **Free tier** — Durable Objects + cron only; no Containers or Sandbox
  required.

---

## 🧠 How it works

```
                ┌─────────────────────────────────────────┐
   cron (2 min) │            Worker (Hono)                 │
   watchdog  ──▶│  scheduled() → Harness.wake()           │
                └───────────────┬─────────────────────────┘
                                ▼
                ┌─────────────────────────────────────────┐
                │             Harness (DO)                  │   The brain.
                │  agent loop: LLM + tools, step by step    │   Persists
                │  stop on: finish | maxSteps | budget |    │   state + logs
                │           idle | repeated loop            │   in SQLite.
                └────┬───────────────┬──────────────────────┘
   RPC delegate      │               │
        ┌───────────▼──┐         ┌──▼───────────────────┐
        │ ResearchAgent │         │ JobApplicationAgent  │
        │   (DO)        │         │   (DO)               │
        │ arXiv + HN    │         │ Arbeitnow + Remotive │
        │ findings DB   │         │ pipeline + letters   │
        └───────────────┘         └──────────────────────┘
```

### The three Durable Objects

| Agent                     | Role                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Harness`**             | The orchestrator. Runs an explicit while-loop where an LLM calls tools (research, jobs, memory, finish) and reacts to their results. Keeps step logs, daily summaries, config, and schedules.                                                       |
| **`ResearchAgent`**       | Capability provider. Fetches real findings from **arXiv** and **Hacker News (Algolia)**, summarizes them, and stores them in its own SQLite.                                                                                                        |
| **`JobApplicationAgent`** | Capability provider. Discovers real listings from **Arbeitnow** and **Remotive**, ranks them, generates tailored cover letters from your profile, and tracks them through a pipeline (discovered → draft → applied → interview → offer → rejected). |

### Grounding principle

Sub-agents fetch **real data** from no-auth HTTPS JSON APIs first; the LLM only
ranks and summarizes what was fetched. This prevents the classic failure mode of
an LLM-with-a-`save_job`-tool inventing companies and URLs. Phantom scores that
don't map to a real listing are dropped.

---

## 🚀 Quick start

The app is split into **two independent Cloudflare origins**:
- **API worker** (`packages/hono-worker`) — a pure REST + WebSocket backend (Hono, Durable Objects, D1, R2). Serves **no HTML**.
- **Frontend worker** (`packages/frontend`) — a standalone **TanStack Start** SSR app that calls the API cross-origin over CORS.

The browser holds the Better Auth session cookie on the **API** origin
(`SameSite=None; Secure`) and sends it with every request via
`credentials: "include"`.

### Prerequisites

- Node.js 22+ (Vite 8 / TypeScript 6)
- A Cloudflare account
- An LLM API key (GLM/OpenAI/Anthropic — see `packages/hono-worker/src/config/llm-config.json`)
- A Resend API key + verified sender domain (for OTP emails)

### 1. Install

```bash
npm install   # root — installs all workspaces
```

### 2. Configure local secrets

Copy the API worker's example env:

```bash
cd packages/hono-worker
cp .dev.vars.example .dev.vars
# Fill in: LLM_API_KEY, AUTH_SECRET (openssl rand -hex 32), RESEND_API_KEY,
#          MAIL_FROM, BETTER_AUTH_URL=http://localhost:8787,
#          FRONTEND_URL=http://localhost:5173
```

`FRONTEND_URL` is the new frontend origin — it's added to the API's CORS
allowlist and Better Auth `trustedOrigins` so the cross-origin SPA can call
`/api/*` with credentials.

Copy the frontend env:

```bash
cd ../frontend
cp .env.example .env
# VITE_API_URL=http://localhost:8787  (the API origin the frontend calls)
```

Auth is multi-tenant: email/password + 6-digit OTP (Better Auth `emailOTP`
plugin, delivered via Resend). The auth directory lives in **D1** (`DB`);
CV/résumé files live in **R2** (`CV_BUCKET`). Run the D1 migration once:

```bash
cd ../hono-worker
npx wrangler d1 migrations apply agent-harness-auth --local   # dev
npx wrangler d1 migrations apply agent-harness-auth --remote  # prod
```

### 3. Run locally (both origins)

```bash
npm run dev   # root: runs API (:8787) + frontend (:5173) concurrently
```

Open `http://localhost:5173`. The frontend talks to the API cross-origin
(`VITE_API_URL`); OTP emails are sent for real via Resend (no dev fallback).

### 4. Deploy (two separate workers)

**API worker** — one-command provisioning:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/setup.sh
```

(set `LLM_API_KEY`, `AUTH_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`,
`BETTER_AUTH_URL`, `FRONTEND_URL` in `packages/hono-worker/.dev.vars` first).

**Frontend worker** — build with the prod API origin baked in, then deploy:

```bash
VITE_API_URL=https://agent-harness.<sub>.workers.dev npm run deploy:web
```

Note the **two URL env vars** that must point at each other's deployed origin:
`FRONTEND_URL` (on the API) and `VITE_API_URL` (on the frontend). Set both to
the real prod URLs after the first deploy. CI (`.github/workflows/deploy.yml`)
runs both deploys on push to `main` — set `VITE_API_URL` as a GitHub secret.

---

## 🔌 Configuration

Backend secrets (set in `packages/hono-worker/.dev.vars` for dev, or via
`wrangler secret put` / the dashboard for prod). See `.dev.vars.example` for
the full list with comments:

| Variable         | Required | Purpose                                                          |
| ---------------- | :------: | ---------------------------------------------------------------- |
| `LLM_API_KEY`    |    ✅    | LLM provider key (GLM/OpenAI/Anthropic — see llm-config.json)    |
| `AUTH_SECRET`    |    ✅    | Signs Better Auth session cookies + extension tokens (`rand -hex 32`) |
| `RESEND_API_KEY` |    ✅    | Resend key for OTP delivery (https://resend.com/api-keys)        |
| `MAIL_FROM`      |    ✅    | Resend-verified sender address for OTP emails                    |
| `BETTER_AUTH_URL`|    –     | Public API origin (e.g. https://agent-harness.x.workers.dev)     |
| `FRONTEND_URL`   |    –     | Public FRONTEND origin — added to CORS allowlist + trustedOrigins|
| `MAX_STEPS`      |    –     | Step ceiling per run (default `100`, in `wrangler.jsonc` vars)   |

Frontend build-time var (set in `packages/frontend/.env` for dev, or as the
`VITE_API_URL` GitHub secret / env var at build time):

| Variable       | Required | Purpose                                              |
| -------------- | :------: | ---------------------------------------------------- |
| `VITE_API_URL` |    ✅    | The API origin the frontend calls cross-origin (CORS)|

### Model config

> **Heads-up (known v1 limitation):** model identity (provider / model / base
> URL) and generation params live in
> [`packages/hono-worker/src/config/llm-config.json`](packages/hono-worker/src/config/llm-config.json),
> which is a **static import — baked at build time**. Switching providers or
> models therefore requires a code change + redeploy (not a runtime edit).
> `PUT /api/config` updates the **goal / maxSteps / token budget** triplet only.

Runtime config (goal, maxSteps, token budget) **is** editable live from the
dashboard without redeploying — persisted in the SQLite `config` table.

### Schedules

Add schedules from the dashboard using 5-field cron expressions (UTC), e.g.:

| Expression     | Meaning                          |
| -------------- | -------------------------------- |
| `0 9 * * 1-5`  | 09:00 UTC, Monday–Friday         |
| `*/30 * * * *` | every 30 minutes                 |
| `0 0,12 * * *` | twice a day at midnight and noon |

Invalid expressions are rejected at submission time. Missed-fire catch-up is
built in (if a window was never served, it triggers on the next watchdog tick).

---

## 🌐 API

Everything under `/api/*` requires a valid Better Auth **session cookie**
(set by `/api/auth/sign-in/email` after OTP verification). The frontend sends
it cross-origin with `credentials: "include"`; the API validates it via
`requireAuth` middleware. A not-yet-onboarded user gets `428` (the frontend's
guards redirect to `/onboarding`). Unauthenticated requests get `401`.

### Signup flow

The signup is two steps on `/signup`, then a profile gate:

1. **Account** — email + password → `signUp.email` creates the user and Better
   Auth emails a 6-digit OTP via Resend.
2. **Verify** — the user enters the code in a segmented OTP input
   (`@agent-harness/ui` `InputOTP`, backed by `input-otp`). `verifyEmail`
   confirms the address and Better Auth's `databaseHooks.user.update.after`
   hook flips `onboardingComplete = 1` on the D1 `user` row.
3. **Profile gate** — the user lands on `/dashboard`, which is guarded by
   `requireProfile` (`packages/frontend/src/lib/guards.ts`). That guard runs in
   the route's `beforeLoad` (before render) and `GET /api/profile`s the user's
   profile; if `firstName` and `lastName` are both non-empty it lets the page
   render, otherwise it redirects to `/settings/profile?required=1`. The
   profile page shows a banner ("Finish setting up your account") until both
   names are filled in. The gate is **separate from onboarding** — it only
   checks the name fields, so it doesn't strand users who skip the legacy
   `/onboarding` form.

Two independent gates therefore protect dashboard routes: `requireAuth`
(session + `onboardingComplete`) and `requireProfile` (profile has a name).
`requireProfile` composes `requireAuth`, so dashboard routes use it directly;
`/settings/profile` uses `requireAuth` alone so it stays reachable while the
name is missing.

> [!CAUTION]
> **Known DO-concurrency limitation:** `start()` awaits the entire multi-minute
> run loop, and Durable Objects serialize their request queue. While a run is
> in flight, **every other `/api/*` call is queued behind it**. The dashboard
> will feel unresponsive during long runs, and `POST /api/pause` / `POST
> /api/resume` can't actually interleave with the loop. (See
> [`docs/REDESIGN.md`](docs/REDESIGN.md) for the planned one-iteration-per-alarm
> fix.) In practice `pause` is a **stop + write-summary**, and `resume` is a
> frontend status flip — true pause/resume is **not implemented**.

| Method        | Path                         | Description                                       |
| ------------- | ---------------------------- | ------------------------------------------------- |
| **Auth**                   |                              |                                                   |
| `GET`/`POST`   | `/api/auth/*`                | Better Auth (sign-up/in/out, OTP verify, session) |
| **Run control**            |                              |                                                   |
| `GET`         | `/api/status`                | Full harness status                               |
| `POST`        | `/api/start`                 | Start a run (optional `{ goal }`)                 |
| `POST`        | `/api/stop`                  | Stop the run                                      |
| `POST`        | `/api/pause`                 | Pause (⚠️ effectively stops — see caveat)         |
| `POST`        | `/api/resume`                | Resume (⚠️ status flip only — see caveat)         |
| **Config / plans / goals** |                              |                                                   |
| `GET` / `PUT` | `/api/config`                | Read / update { goal, maxSteps, tokenBudget }     |
| `GET` / `PUT` | `/api/goal`                  | Read / set the active goal                        |
| `POST`        | `/api/goal/synthesize`       | Auto-synthesize a goal from capabilities          |
| `GET`         | `/api/plan`                  | Current/next structured plan                      |
| `POST`        | `/api/plan/advance`          | Advance a plan step                               |
| **Schedules**              |                              |                                                   |
| `GET`         | `/api/schedules`             | List schedules                                    |
| `POST`        | `/api/schedules`             | Add a schedule `{ cron, focus }`                  |
| `DELETE`      | `/api/schedules/:id`         | Remove a schedule                                 |
| `PUT`         | `/api/schedules/:id/toggle`  | Enable/disable a schedule                         |
| **Traces / logs**          |                              |                                                   |
| `GET`         | `/api/runs`                  | Recent runs                                       |
| `GET`         | `/api/runs/:runId/events`    | Trace events for a run (`?sinceSeq=N`)            |
| `GET`         | `/api/run/:runId/trace`      | Trace summary for a run                           |
| `GET`         | `/api/trace-events`          | Most-recent trace events (`?limit=`)              |
| `GET`         | `/api/log`                   | Step log (`?limit=`)                              |
| `GET`         | `/api/summaries`             | Per-run daily summaries                           |
| `GET`         | `/api/tokens-by-day`         | Token spend grouped by day                        |
| `GET`         | `/api/turn-tokens`           | Per-turn output token stats                       |
| **Memory**                 |                              |                                                   |
| `GET` / `PUT` | `/api/memory`                | Agent-recalled facts (the `context` table)        |
| `DELETE`      | `/api/memory/:key`           | Forget a fact                                     |
| `GET` / `PUT` | `/api/user-memory`           | Operator notes injected into every prompt         |
| `DELETE`      | `/api/user-memory/:key`      | Delete an operator note                           |
| **Jobs**                   |                              |                                                   |
| `GET`         | `/api/pipeline`              | Job pipeline grouped by stage                     |
| `POST`        | `/api/jobs`                  | Manually add a job                                |
| `PUT`         | `/api/jobs/:id/status`       | Move a job stage                                  |
| `POST`        | `/api/jobs/:id/cover-letter` | Generate a cover letter                           |
| `POST`        | `/api/jobs/:id/follow-up`    | Add a follow-up reminder                          |
| `GET` / `PUT` | `/api/profile`               | Read / update user profile (CV/preferences)       |
| `GET`         | `/api/follow-ups`            | Due follow-ups                                    |

---

## 📁 Project structure

```
packages/
  hono-worker/                # 🟦 BACKEND — pure REST API + WS relay (Cloudflare Worker)
    src/
      index.ts                # Hono router: /api/* + /browser/relay + scheduled() cron
      auth/                   # Better Auth (email/password + emailOTP) + Resend + requireAuth
      agents/                 # Durable Objects: Harness, JobApplicationAgent, Browser*, RateLimiter
      tools/                  # agent tool registry
      config/                 # llm-config.json, observability-config.json, rate-limits.json
      types/env.ts            # Env bindings (D1, R2, DOs — NO ASSETS; serves no files)
    wrangler.jsonc            # DOs, cron, D1, R2 — NO assets binding
    migrations/               # D1 auth schema
    .dev.vars.example         # LLM_API_KEY, AUTH_SECRET, RESEND_API_KEY, FRONTEND_URL, …

  frontend/                   # 🟩 FRONTEND — standalone TanStack Start SSR app (Cloudflare Worker)
    src/
      routes/                 # file-based routes (13): __root.tsx (HTML shell + guards),
                              #   index/login/signup/forgot-password/onboarding/dashboard/
                              #   jobs/logs/memory/settings (→ redirects) +
                              #   settings/profile + traces/$runId
      pages/                  # the page components rendered by the routes
      router.tsx              # getRouter() — Start's per-request factory
      lib/api.ts  lib/auth.ts # cross-origin clients (VITE_API_URL + credentials:include)
    vite.config.ts            # tailwindcss + cloudflare + tanstackStart + react (in that order)
    wrangler.jsonc            # main: @tanstack/react-start/server-entry (frontend Worker)
    .env.example              # VITE_API_URL (the API origin)

  ui/                         # shared shadcn/ui primitives (@agent-harness/ui, raw TSX)
  shared-types/               # browser-safe types shared by both sides (@agent-harness/shared-types)
scripts/
  setup.sh                    # provisions the API worker (secrets + deploy)
prompts/                      # agent system-prompt templates
docs/
  future-phases.md            # CV→markitdown + feature phases (not yet built)
  REDESIGN.md                 # v1 redesign decisions + known TODOs
```

---

- **Cloudflare Workers** + **Durable Objects** (SQLite-backed persistence)
- **[`agents`](https://developers.cloudflare.com/agents/) SDK** (installed via
  `agents@latest`) — provides `getAgentByName`, `this.sql` tagged templates,
  `schedule()` + alarm-based self-healing, and the RPC decorator. *(Pre-1.0;
  some APIs are unstable and may require a cast.)*
- **Vercel AI SDK** (`ai@latest`, `@ai-sdk/anthropic@latest`,
  `@ai-sdk/openai@latest`)
- **Hono 4** — the API worker's HTTP router (pure REST + WS relay, no HTML)
- **TanStack Start** (`@tanstack/react-start`) + **Vite 8** + **React 19** —
  the standalone SSR frontend, deployed as its own Cloudflare Worker via
  `@cloudflare/vite-plugin`. File-based routing, `shellComponent` renders the
  HTML document server-side.
- **Better Auth** — email/password + `emailOTP` (6-digit codes via Resend),
  cross-origin session cookie (`SameSite=None; Secure`)
- **Tailwind CSS v4** + **shadcn/ui** (`@agent-harness/ui` shared primitives)
- **cron-parser** (schedule matching + missed-fire catch-up, pinned to UTC)
- **Zod** (tool parameter schemas)
- **Workers observability** — `trace_events` SQLite table + live-poll endpoint,
  powered by `src/observability-config.json` and `wrangler.jsonc`'s built-in
  `observability.logs.traces` block

---

## 🧯 Safety & cost controls

The agent loop enforces multiple independent stop conditions:

1. **`finish` tool** — the LLM ends the run itself when the goal is met.
2. **`maxSteps`** — hard ceiling on LLM turns per run (default **100**).
3. **Token budget** — soft cumulative-token ceiling per run. ⚠️ **Defaults to 0
   (unlimited).** Set a sensible value (e.g. 500k) from the dashboard before
   trusting long runs.
4. **Idle detection** — no tool call for two consecutive turns → stop.
5. **Repeated-loop detection** — same tool + identical args twice → stop.

This bounds LLM spend even if the agent gets confused — but **gaps remain**:

- **No rate-limiting** on `/api/*`. A valid token holder can spam
  `POST /api/start` and trigger unbounded spend.
- **`CORS origin: "*"`** on all routes — fine for a personal dashboard, a
  concern for any multi-user deployment.
- The dashboard polls `/api/status` every ~8s; during a long run that endpoint
  is queued behind the loop (see [API caveat](#-api)).

---

## 📈 Notes on the v1 (free-tier) design

<details>
<summary>This is the <strong>v1 free-tier</strong> variant (click to expand)</summary>

Durable Objects + cron only — no Containers or Sandbox. Ground truth comes from
the research/jobs capability-provider tools (HTTPS JSON APIs) rather than shell
execution. A future **v2 (paid-tier)** variant can re-add a `Sandbox` container
for arbitrary code execution.

</details>

---

## 🤝 Contributing

Contributions are welcome! This is a small, focused project — please keep
changes consistent with the architecture described above.

1. Fork the repository and create a feature branch
   (`git checkout -b feat/my-change`).
2. Make your changes. Verify both sides typecheck — `npm run typecheck`
   (runs the frontend + the worker) — and `npm run test:unit` before committing.
3. Open a pull request describing **what** changed and **why**.

### Areas that welcome help

- New grounded data sources for the Job agent (no-auth HTTPS JSON APIs only,
  to keep the free-tier design).
- A v2 (paid-tier) variant that adds a `Sandbox` container for code execution.
- Additional LLM providers in `packages/hono-worker/src/config/llm-config.json`.
- Frontend feature pages (Job Detail, Cover Letter editor, Schedules manager,
  Goal/Plan editor — see `docs/future-phases.md`).

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

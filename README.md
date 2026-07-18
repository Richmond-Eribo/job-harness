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

### Prerequisites

- Node.js 18+
- A Cloudflare account
- An LLM API key (Anthropic **or** OpenAI)
- `wrangler` CLI (bundled as a dev dependency)

### 1. Install

```bash
npm install
```

### 2. Configure local secrets

Create a `.dev.vars` file in the project root (see `.dev.vars.example`):

```bash
LLM_API_KEY=sk-...            # your LLM provider key (GLM/OpenAI/Anthropic)
AUTH_SECRET=                  # generate: openssl rand -hex 32
RESEND_API_KEY=               # optional — omit to log magic links in dev
BETTER_AUTH_URL=http://localhost:8787
```

Auth is multi-tenant: users sign in via **Better Auth magic link** (email →
signed session cookie). The auth directory lives in **D1** (`DB` binding);
CV/résumé files live in **R2** (`CV_BUCKET`). Both bindings are pre-wired in
`wrangler.jsonc` — run the D1 migration once:

```bash
npx wrangler d1 migrations apply agent-harness-auth --local   # dev
npx wrangler d1 migrations apply agent-harness-auth --remote  # prod
```

### 3. Run locally

**Backend** (the Worker + all Durable Objects):

```bash
npm run dev
```

**Frontend** (the Vite + TanStack Router SPA) — in a second terminal:

```bash
cd frontend && npm install && npm run dev
```

The Vite dev server runs on `:5173` and proxies `/api` to the Worker on
`:8787`. Open `http://localhost:5173/app` for the new SPA. The legacy SSR
dashboard remains at `http://localhost:8787/` during the cutover.

In dev (no `RESEND_API_KEY`), magic links are logged to the Worker console
and surfaced in the login page — click through to sign in without an email
provider.

### 4. Deploy

The one-command provisioning script sets the secrets and deploys:

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
LLM_API_KEY=... \
DASHBOARD_TOKEN=... \
./scripts/setup.sh
```

Or do it manually:

```bash
npx wrangler secret put LLM_API_KEY
npx wrangler secret put DASHBOARD_TOKEN
npx wrangler deploy
```

The cron watchdog will start the first scheduled run automatically (within ~2
minutes of a schedule being due).

---

## 🔌 Configuration

All toggable config lives in env vars / secrets:

| Variable          | Required | Purpose                                    |
| ----------------- | :------: | ------------------------------------------ |
| `LLM_API_KEY`     |    ✅    | Anthropic **or** OpenAI API key            |
| `DASHBOARD_TOKEN` |    ✅    | Bearer token for `/api/*` + dashboard auth |
| `LLM_PROVIDER`    |    –     | `anthropic` (default) or `openai`          |
| `LLM_MODEL`       |    –     | e.g. `claude-sonnet-4-20250514`, `gpt-4o`  |
| `MAX_STEPS`       |    –     | Step ceiling per run (default `100`)       |

### Model config

> **Heads-up (known v1 limitation):** model identity (provider / model / base
> URL) and generation params live in [`src/llm-config.json`](src/llm-config.json),
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

Everything under `/api/*` requires an `Authorization: Bearer <DASHBOARD_TOKEN>`
header.

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
| `GET`         | `/`                          | Dashboard (HTML, Overview page)                   |
| `GET`         | `/jobs`                      | Jobs Kanban + covers (HTML page)                  |
| `GET`         | `/traces`                    | Trace viewer (HTML page)                          |
| `GET`         | `/logs`                      | Step logs (HTML page)                             |
| `GET`         | `/memory`                    | Memory editor (HTML page)                         |
| `GET`         | `/settings`                  | Config editor (HTML page)                         |
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
| **Research**               |                              |                                                   |
| `GET`         | `/api/research`              | Topics + recent findings                          |
| `POST`        | `/api/research/run`          | Trigger a search `{ topic, depth }`               |
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
src/
  index.ts           # Hono router, API routes, cron watchdog, DO exports
  db.ts              # SQL helpers (execSql tagged-template shim)
  llm.ts             # Model-agnostic LLM factory (BYOK)
  llm-config.json    # ⚙ static model config (baked at build time)
  observability-config.json  # trace-event capture toggles
  types.ts           # Shared types
  agents/
    harness.ts           # The orchestrator (autonomous agent loop + DB)
    research-agent.ts    # arXiv + Hacker News capability agent
    job-agent.ts         # job discovery + cover letters + pipeline agent
    prompt.ts            # System-prompt builder
    prompt-loader.ts     # Loads prompts/ from disk
    index.ts             # Agent exports
  tools/
    finish.tool.ts  research.tool.ts  jobs.tool.ts  memory.tool.ts
    index.ts              # tool registry wired into the harness
  types/
    env.ts harness.ts index.ts job.ts log.ts memory.ts
    research.ts schedule.ts trace.ts
  utils/
    cron.ts          # range/step/list parsing + missed-fire catch-up
    get-agents.ts    # getAgentByName wrappers
    run.ts           # run helpers
    trace.ts         # trace-event emission helpers
  db/
    db.ts            # low-level SQL plumbing
  views/
    Layout.tsx           # <html> shell + nav
    renderDashboard.tsx  # page renderer
    pages/
      Overview.tsx Jobs.tsx Traces.tsx Logs.tsx Memory.tsx Settings.tsx
public/
  css/dashboard.css
  js/dashboard.js   markdown.js   json.js
  # markdown.js  — client-side Markdown rendering for LLM output
  # json.js       — pretty-printing for tool I/O
scripts/
  setup.sh               # one-command provisioning
prompts/
  default.md   # default system-prompt template
  soul.md      # higher-order agent persona / philosophy
docs/
  implementation_plan.md
  REDESIGN.md            # v1 redesign decisions + known TODOs
wrangler.jsonc           # DOs, cron trigger, vars, assets
```

---

- **Cloudflare Workers** + **Durable Objects** (SQLite-backed persistence)
- **[`agents`](https://developers.cloudflare.com/agents/) SDK** (installed via
  `agents@latest`) — provides `getAgentByName`, `this.sql` tagged templates,
  `schedule()` + alarm-based self-healing, and the RPC decorator. *(Pre-1.0;
  some APIs are unstable and may require a cast.)*
- **Vercel AI SDK** (`ai@latest`, `@ai-sdk/anthropic@latest`,
  `@ai-sdk/openai@latest`)
- **Hono 4** — HTTP router + server-rendered JSX dashboard (no SPA / build step
  for the UI; static assets in `public/` served by the platform)
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
2. Make your changes. Verify with `npx tsc --noEmit` (0 errors) before
   committing.
3. Open a pull request describing **what** changed and **why**.

### Areas that welcome help

- New grounded data sources for the Research/Job agents (no-auth HTTPS JSON APIs
  only, to keep the free-tier design).
- A v2 (paid-tier) variant that adds a `Sandbox` container for code execution.
- Additional LLM providers in `src/llm.ts` (Gemini, Mistral, etc.).
- Dashboard UX improvements (`src/views/`, `public/`).

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

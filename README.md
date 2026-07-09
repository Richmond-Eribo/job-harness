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
- **Persistent memory** — per-agent SQLite storage. Findings, the job pipeline,
  run summaries, and explicit "remembered" facts all survive across runs.
- **Schedules via full cron** — ranges, steps, lists, named days. Powered by
  `cron-parser` (no failing hand-rolled matchers).
- **Cost-bounded** — hard stops on `maxSteps`, a token budget, idle detection,
  and repeated-loop detection.
- **Dashboard** — live status, controls, logs, schedules, research findings, and
  a job Kanban pipeline.
- **Model-agnostic** — switch between Anthropic Claude and OpenAI GPT purely via
  env vars.
- **Free tier** — Durable Objects + cron only; no Containers or Sandbox
  required.

---

## 🧠 How it works

```
                ┌─────────────────────────────────────────┐
   cron (2 min) │            Worker (Hono)                 │
   watchdog  ──▶│  scheduled() → Harness.checkSchedulesDue│
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

Create a `.dev.vars` file in the project root:

```bash
LLM_API_KEY=sk-...            # your Anthropic or OpenAI key
DASHBOARD_TOKEN=some-secret   # any strong token for dashboard auth
LLM_PROVIDER=anthropic        # or "openai"
LLM_MODEL=claude-sonnet-4-20250514
```

Provider/model can also be set in `wrangler.jsonc` under `vars`.

### 3. Run locally

```bash
npm run dev
```

Open the dashboard at the URL Wrangler prints (usually `http://localhost:8787`).
You'll be prompted for your `DASHBOARD_TOKEN`.

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

Runtime config (goal, maxSteps, token budget) can also be changed live from the
dashboard without redeploying — it's persisted in SQLite.

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

Everything under `/api/*` requires a `Authorization: Bearer <DASHBOARD_TOKEN>`
header.

| Method        | Path                         | Description                         |
| ------------- | ---------------------------- | ----------------------------------- |
| `GET`         | `/`                          | Dashboard (HTML)                    |
| `GET`         | `/api/status`                | Full harness status                 |
| `POST`        | `/api/start`                 | Start a run (optional `{ goal }`)   |
| `POST`        | `/api/stop`                  | Stop the run                        |
| `POST`        | `/api/pause`                 | Pause                               |
| `POST`        | `/api/resume`                | Resume                              |
| `GET` / `PUT` | `/api/config`                | Read / update live config           |
| `GET`         | `/api/schedules`             | List schedules                      |
| `POST`        | `/api/schedules`             | Add a schedule `{ cron, focus }`    |
| `DELETE`      | `/api/schedules/:id`         | Remove a schedule                   |
| `PUT`         | `/api/schedules/:id/toggle`  | Enable/disable a schedule           |
| `GET`         | `/api/log`                   | Step log (`?limit=`)                |
| `GET`         | `/api/summaries`             | Per-run summaries                   |
| `GET`         | `/api/research`              | Topics + recent findings            |
| `POST`        | `/api/research/run`          | Trigger a search `{ topic, depth }` |
| `GET`         | `/api/pipeline`              | Job pipeline grouped by stage       |
| `POST`        | `/api/jobs`                  | Manually add a job                  |
| `PUT`         | `/api/jobs/:id/status`       | Move a job stage                    |
| `POST`        | `/api/jobs/:id/cover-letter` | Generate a cover letter             |
| `POST`        | `/api/jobs/:id/follow-up`    | Add a follow-up reminder            |
| `GET`         | `/api/profile`               | Read user profile (CV/preferences)  |
| `PUT`         | `/api/profile`               | Update profile                      |
| `GET`         | `/api/follow-ups`            | Due follow-ups                      |

---

## 📁 Project structure

```
src/
  index.ts           # Hono router, API routes, cron watchdog, DO exports
  harness.ts         # The orchestrator (autonomous agent loop + tools)
  research-agent.ts  # arXiv + Hacker News capability agent
  job-agent.ts       # job discovery + cover letters + pipeline agent
  llm.ts             # Model-agnostic LLM factory (BYOK)
  types.ts           # Shared types: Env, state, domain models
  views/             # Hono JSX dashboard (Layout, Dashboard, renderDashboard)
public/
  css/dashboard.css
  js/dashboard.js
scripts/
  setup.sh           # one-command provisioning
docs/
  task.md            # build progress tracker
  implementation_plan.md
wrangler.jsonc       # DOs, cron trigger, vars, assets
```

---

## 🛠️ Tech stack

- **Cloudflare Workers** + **Durable Objects** (SQLite-backed persistence)
- **`agents` SDK** (`unstable_callable` RPC, `getAgentByName`, `this.sql` tagged
  templates)
- **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`)
- **Hono** (HTTP router + JSX dashboard)
- **cron-parser** (schedule matching + missed-fire catch-up, pinned to UTC)
- **Zod** (tool parameter schemas)

---

## 🧯 Safety & cost controls

The agent loop enforces multiple independent stop conditions:

1. **`finish` tool** — the LLM ends the run itself when the goal is met.
2. **`maxSteps`** — hard ceiling on LLM turns per run.
3. **Token budget** — soft cumulative-token ceiling per run (0 = unlimited).
4. **Idle detection** — no tool call for two consecutive turns → stop.
5. **Repeated-loop detection** — same tool + identical args twice → stop.

This bounds LLM spend even if the agent gets confused.

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

<div align="center">

# 🤖 Job Agent

**An autonomous job-application agent that runs on Cloudflare's free tier —
with a dashboard to review everything it prepares and steer it.**

It discovers jobs from the boards you allowlist, scores them against your
profile, drafts a tailored CV and cover letter for each match, and can assist
your application in your own browser — while you do literally anything else.

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
> Built with the Cloudflare [`agents`](https://developers.cloudflare.com/agents/)
> SDK, Durable Objects (SQLite-backed), a cron-based self-healing watchdog,
> and the Vercel AI SDK (BYOK — bring your own key, Anthropic or OpenAI).
>
> Full design document: [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

## 📑 Table of contents

- [Features](#-features)
- [How it works](#-how-it-works)
- [Quick start](#-quick-start)
- [Configuration](#-configuration)
- [API](#-api)
- [Project structure](#-project-structure)
- [Tech stack](#-tech-stack)
- [Safety & cost controls](#-safety--cost-controls)
- [Testing](#-testing)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

- **True autonomous agent** — not a scripted workflow. An LLM plans every run,
  observes tool results, and decides the next action until the goal is met.
- **Actor-loop runtime** — one LLM turn per Durable Object alarm tick, with a
  checkpoint after every step. Runs survive eviction and deploys; pause /
  stop / status stay responsive mid-run.
- **Grounded, never hallucinated** — jobs are discovered only from the
  **sources you configure** (browse or search-template mode), parsed with
  HTMLRewriter, and guarded by a server-side **origin check** on every fetch
  and save. The prompt forbids inventing job fields; the code enforces it.
- **Tailored CVs + cover letters** — your CV is parsed to text on upload
  (`cvText`); the agent re-orders and re-emphasizes your **real** experience
  per job (never invents employers, dates, or skills). Every generation is a
  new **version** you can compare, regenerate, copy, and print to PDF.
- **Kanban pipeline with drag & drop** — six stages
  (`discovered → draft → applied → interview → offer`, plus `rejected`),
  pointer + keyboard dragging, optimistic moves, URL-shareable filters
  (`/jobs?q=…&status=…`), and a per-card menu (move / reject / remove).
- **Job detail pages** (`/jobs/:id`) — posting + private notes editor,
  versioned cover letters and tailored CVs, follow-ups, apply link, and
  **Apply with agent** (a focused run that opens the posting in your paired
  browser and assists — it never submits and never logs in).
- **Browser control via your real Chrome** — a MV3 extension speaks CDP over
  an outbound WebSocket to a relay Durable Object, so the agent can read
  login-walled boards (Indeed, LinkedIn) with your real session. Login-wall
  detection stops the agent cold; a domain allowlist can hard-restrict it.
- **Follow-ups that don't get lost** — moving a job to **Applied**
  automatically schedules a nudge ~7 days out (editable, completable,
  deletable); due nudges surface on the kanban card and the Overview list.
- **Two memory layers** — **agent memory** (`remember`/`recall` tools) and
  **user memory** (operator notes injected into every prompt as
  higher-authority guidance).
- **Full observability** — every run emits a structured, append-only trace
  event stream (`run_start`, `system`, `prompt`, `reasoning`, `text`,
  `tool_call`, `tool_result`, `step_end`, `run_end`, `error`) with token
  counts, nesting columns for sub-agent activity, live-poll transcript, and
  per-day / per-turn dashboards.
- **Schedules via full cron** — ranges, steps, lists, named days, powered by
  `cron-parser`. A 2-minute watchdog self-heals missed windows.
- **Light, fast dashboard** — white surfaces, one blue accent, flat 1px
  borders, **Geist + Open Sans** (the only two families), 16/14px type floor.
  Landing, auth, onboarding, and every app page share the same design system.
- **Multi-tenant from day one** — Better Auth (email/password + 6-digit OTP
  via Resend); every Durable Object is named by userId, so each user's data
  is physically isolated.
- **Model-agnostic** — Anthropic, OpenAI, or any compatible endpoint,
  configured via `src/llm-config.json` (see [Model config](#model-config)).
- **Free tier** — Durable Objects + cron only; no Containers or Sandbox
  required.

---

## 🧠 How it works

```
              ┌──────────────────────────────────────────┐
 cron (2 min) │             Worker (Hono)                 │
 watchdog  ──▶│  scheduled() → Harness.wake() per user    │
              └────────────────┬─────────────────────────┘
                               ▼
              ┌──────────────────────────────────────────┐
              │            Harness (DO per user)          │   The brain.
              │  actor loop: ONE LLM turn per alarm tick  │   Persists
              │  checkpoint after every step              │   state + logs
              │  stop on: finish | maxSteps | budget |    │   in SQLite.
              │           idle | repeated loop | pause    │
              └───────┬──────────────────┬───────────────┘
        RPC delegate  │                  │
         ┌────────────▼───┐      ┌───────▼──────────────────────────┐
         │ JobApplication │      │ BrowserRelay ◀── Chrome extension │
         │ Agent (DO)     │      │ BrowserAgent (DO)                │
         │ sources guard, │      │ navigate / observe / act /        │
         │ discovery, CVs │      │ extract on the user's real Chrome │
         │ + letters      │      └──────────────────────────────────┘
         └────────────────┘      (+ RateLimiter DO — global limits)
```

### The Durable Object cast (one set per user, named by userId)

| DO                        | Role                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Harness`**             | The orchestrator. Actor-loop agent (one LLM turn per alarm tick), planning, layered system prompts, context compaction, checkpoints for crash recovery, schedules, memory, and the trace log.     |
| **`JobApplicationAgent`** | The jobs domain. Owns job sources (the origin guard), the discovery inner loop, the pipeline, profile + `cvText`, versioned cover letters **and tailored CVs**, and follow-ups.                     |
| **`BrowserRelay`**        | WebSocket bridge to the user's Chrome extension (outbound WSS from the extension, JWT in the subprotocol, frame queue).                                                                            |
| **`BrowserAgent`**        | Drives the relay: `navigate / observe / act / extract / browse`, login-wall detection, action caps.                                                                                                |
| **`RateLimiter`**         | Global sliding-window limiter guarding the shared LLM key (per-user LLM window, one active run per user) and sensitive endpoints (CV upload, pairing, cover letters, tailored CVs, probes).         |

### The product flow

```
Onboarding (profile → CV → pair browser)
   │
   ▼
Discover jobs (sources, browser)  ──▶  Discovered
   │                                        │  agent during runs, or you on demand
   ▼                                        ▼
Tailored CV + cover letter  ──▶  Draft (versioned, grounded in your real CV)
   │
   ▼
You review / regenerate  ──▶  Apply (link, or "Apply with agent" run)
   │
   ▼
Applied  ──▶  follow-up nudged automatically (+7 days)
   │
   ▼
Interview ──▶ Offer   (or Rejected)
```

**The division of labor is deliberate:** the agent prepares everything; the
human decides and applies. The "applied" transition is always a human action,
and the agent never submits an application or logs in anywhere.

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
# Optional: E2E_OTP_BYPASS=1 (deterministic "999999" OTPs for the e2e suite —
#          local dev ONLY, never in production)
```

`FRONTEND_URL` is the frontend origin — it's added to the API's CORS
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

Open `http://localhost:5173`, sign up (OTP email arrives via Resend), and the
3-step onboarding wizard walks you through profile → CV → browser pairing.
Two default job sources (Reed, HN Who Is Hiring) are seeded unless you opt
out, so your first run has something to chew on.

To let the agent drive your real Chrome, load the unpacked
[`extension/`](extension/) folder in `chrome://extensions` and pair it with a
code from Settings → Browser & Extension (or the onboarding's last step).

### 4. Deploy (two separate workers)

**API worker** — one-command provisioning:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/setup.sh
```

(set `LLM_API_KEY`, `AUTH_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`,
`BETTER_AUTH_URL`, `FRONTEND_URL` in `packages/hono-worker/.dev.vars` first —
and do **not** set `E2E_OTP_BYPASS` in production.)

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

| Variable          | Required | Purpose                                                           |
| ----------------- | :------: | ----------------------------------------------------------------- |
| `LLM_API_KEY`     |    ✅    | LLM provider key (GLM/OpenAI/Anthropic — see llm-config.json)     |
| `AUTH_SECRET`     |    ✅    | Signs Better Auth session cookies + extension tokens (`rand -hex 32`) |
| `RESEND_API_KEY`  |    ✅    | Resend key for OTP delivery (https://resend.com/api-keys)         |
| `MAIL_FROM`       |    ✅    | Resend-verified sender address for OTP emails                     |
| `BETTER_AUTH_URL` |    –     | Public API origin (e.g. https://agent-harness.x.workers.dev)      |
| `FRONTEND_URL`    |    –     | Public FRONTEND origin — added to CORS allowlist + trustedOrigins |
| `MAX_STEPS`       |    –     | Step ceiling per run (default `100`, in `wrangler.jsonc` vars)    |
| `E2E_OTP_BYPASS`  |    –     | **Local dev only**: deterministic `"999999"` OTPs for the e2e suite |

Frontend build-time var (set in `packages/frontend/.env` for dev, or as the
`VITE_API_URL` GitHub secret / env var at build time):

| Variable       | Required | Purpose                                               |
| -------------- | :------: | ----------------------------------------------------- |
| `VITE_API_URL` |    ✅    | The API origin the frontend calls cross-origin (CORS) |

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

Add schedules from Settings → Schedules using 5-field cron expressions (UTC),
e.g.:

| Expression     | Meaning                          |
| -------------- | -------------------------------- |
| `0 9 * * 1-5`  | 09:00 UTC, Monday–Friday         |
| `*/30 * * * *` | every 30 minutes                 |
| `0 0,12 * * *` | twice a day at midnight and noon |

Invalid expressions are rejected at submission time. Missed-fire catch-up is
built in (if a window was never served, it triggers on the next watchdog tick).

---

## 🌐 API

Everything under `/api/*` requires a valid Better Auth **session cookie**.
The frontend sends it cross-origin with `credentials: "include"`; the API
validates it via `requireAuth` middleware. A not-yet-onboarded user gets
`428` (the frontend's guards redirect to `/onboarding`); unauthenticated
requests get `401`. Public exemptions: `/healthz`, the auth endpoints, the
extension's pairing/refresh routes, and `/api/browser/status` (the onboarding
wizard polls it live).

### Signup + onboarding flow

1. **Account** — email + password (+ names) on `/signup`; Better Auth emails
   a 6-digit OTP via Resend.
2. **Verify** — the segmented OTP input auto-submits on the sixth digit.
   Verification flips `onboardingComplete = 1` and drops you on `/dashboard`.
3. **Onboarding wizard** (users still flagged not-onboarded, e.g. seeded or
   legacy accounts) — three steps: **Profile → CV upload → Connect browser**,
   ending with `POST /api/onboarding`. The CV step parses your file to
   `cvText` (PDF via `unpdf`, DOCX via `fflate`) so CV tailoring is grounded
   in real content.

A pre-flight endpoint (`GET /api/start/preflight`) reports what's missing
(CV / job sources / browser) before any run; the Overview page shows the same
readiness checklist permanently.

### Endpoint reference

| Method          | Path                            | Description                                          |
| --------------- | ------------------------------- | ---------------------------------------------------- |
| **Auth / account** |                                |                                                      |
| `GET`/`POST`    | `/api/auth/*`                   | Better Auth (sign-up/in/out, OTP verify, session)    |
| `POST`          | `/api/onboarding`               | Complete onboarding (profile fields + seed sources)  |
| `GET`           | `/api/account/export`           | Full JSON export (everything except CV bytes)         |
| `DELETE`        | `/api/account`                  | Irrevocable delete (D1 + DOs + R2)                    |
| **Run control** |                                 |                                                      |
| `GET`           | `/api/status`                   | Full harness status                                  |
| `GET`           | `/api/start/preflight`          | Readiness gaps (`cv` / `job-sources` / `browser`)    |
| `POST`          | `/api/start`                    | Start a run (optional `{ goal }`)                     |
| `POST`          | `/api/stop` · `/pause` · `/resume` | Stop / pause / resume (real — the actor loop checkpoints between ticks) |
| **Config / plans / goals** |                     |                                                      |
| `GET` / `PUT`   | `/api/config`                   | Read / update { goal, maxSteps, tokenBudget }        |
| `GET` / `PUT`   | `/api/goal` · `POST /api/goal/synthesize` | Read/set/auto-synthesize the goal         |
| `GET`           | `/api/plan` · `POST /api/plan/advance` | Current plan / advance a step                |
| **Schedules**   |                                 |                                                      |
| `GET`/`POST`    | `/api/schedules`                | List / add schedules (`{ cron, focus }`)             |
| `DELETE`        | `/api/schedules/:id`            | Remove a schedule                                    |
| `PUT`           | `/api/schedules/:id/toggle`     | Enable/disable a schedule                            |
| **Jobs pipeline** |                                |                                                      |
| `GET`           | `/api/pipeline`                 | Listings + stats (`total`, `byStatus`, `dueFollowUps`) |
| `GET`           | `/api/jobs/:id`                 | Job detail: listing + cover letters + tailored CVs + follow-ups |
| `PUT`           | `/api/jobs/:id`                 | Edit notes / priority                                |
| `DELETE`        | `/api/jobs/:id`                 | Delete (cascades letters, CVs, follow-ups)           |
| `POST`          | `/api/jobs`                     | Manually add a job (deduped by URL or company+title) |
| `PUT`           | `/api/jobs/:id/status`          | Move a job stage (**validated enum**, 400 otherwise). First move to `applied` auto-creates a follow-up |
| `POST`          | `/api/jobs/:id/cover-letter`    | Generate a cover letter (versioned, rate-limited)    |
| `GET`           | `/api/jobs/:id/cover-letters`   | Cover letter versions (newest first)                 |
| `POST`          | `/api/jobs/:id/tailored-cv`     | Generate a tailored CV (grounded in `cvText`, versioned; 422 if CV unparsed) |
| `GET`           | `/api/jobs/:id/tailored-cvs`    | Tailored CV versions (newest first)                  |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/job-sources[/:id]` | CRUD for allowlisted job sites               |
| `POST`          | `/api/jobs/:id/follow-up`       | Schedule a follow-up `{ dueDate, note }`             |
| `GET`           | `/api/follow-ups`               | Due + incomplete follow-ups                          |
| `PUT` / `DELETE`| `/api/follow-ups/:id`           | Complete/edit / delete a follow-up                   |
| **Profile / CV**|                                 |                                                      |
| `GET` / `PUT`   | `/api/profile`                  | Read / update user profile (incl. parsed `cvText`)   |
| `POST`          | `/api/profile/cv`               | Upload CV → R2 + parse to text (10 MB cap)           |
| `GET`           | `/api/profile/cv`               | Download the stored CV                               |
| **Browser / extension** |                           |                                                      |
| `POST`          | `/api/browser/pair`             | Mint a 6-char pairing code (5 min TTL)               |
| `POST`          | `/api/browser/pair/redeem`      | Extension redeems code → refresh token (public)      |
| `POST`          | `/api/browser/refresh`          | Extension access-token refresh (public)              |
| `GET`           | `/api/browser/status`           | Relay status (live/managed/none)                     |
| `POST`          | `/api/browser/probe`            | Navigate + observe test                              |
| `POST`          | `/api/browser/disconnect` · `/unpair` | Drop connection / revoke all browsers          |
| **Traces / logs / memory** |                        |                                                      |
| `GET`           | `/api/runs` · `/api/runs/:runId` | Run list / single run + events                      |
| `GET`           | `/api/runs/:runId/events`       | Trace events (`?sinceSeq=N` long-poll)               |
| `GET`           | `/api/log` · `/api/trace-events` | Derived activity log / recent events                |
| `GET`           | `/api/tokens-by-day` · `/api/turn-tokens` · `/api/summaries` · `/api/notifications` | Usage + digest endpoints |
| `GET`/`PUT`/`DELETE` | `/api/memory[/:key]` · `/api/user-memory[/:key]` | Agent / operator memory CRUD |

---

## 📁 Project structure

```
packages/
  hono-worker/                # 🟦 BACKEND — pure REST API + WS relay (Cloudflare Worker)
    src/
      index.ts                # Hono router: /api/* + /browser/relay + scheduled() cron
      auth/                   # Better Auth (email/password + emailOTP) + Resend + requireAuth
      agents/                 # DOs: Harness, JobApplicationAgent, BrowserRelay,
                              #      BrowserAgent, RateLimiter
      tools/                  # agent tools (jobs, browser, memory, finish)
      utils/cv-text.ts        # CV → text extraction (unpdf / fflate)
      config/                 # llm-config.json, observability-config.json
    wrangler.jsonc            # DOs, cron, D1, R2 — NO assets binding
    migrations/               # D1 auth schema
    .dev.vars.example         # LLM_API_KEY, AUTH_SECRET, RESEND_API_KEY, …
    src/test/                 # vitest unit tests (incl. cv-text extraction)

  frontend/                   # 🟩 FRONTEND — standalone TanStack Start SSR app (Cloudflare Worker)
    src/
      routes/                 # file-based routes: __root, /, login, signup,
                              #   forgot-password, onboarding + authed _app/
                              #   dashboard, jobs, jobs/$jobId, traces/$runId,
                              #   logs, memory, settings
      pages/                  # page components (JobsPage kanban, JobDetailPage, …)
      lib/                    # api client, auth, guards, status meta, formatting
      hooks/queries.ts        # TanStack Query hooks for the whole API surface
      index.css               # design tokens (light theme, Geist + Open Sans)
    .env.example              # VITE_API_URL (the API origin)

  ui/                         # shared shadcn/ui primitives (@agent-harness/ui)
  shared-types/               # browser-safe types shared by both sides
  e2e/                        # Playwright suite (seeds local D1, boots dev servers)
extension/                    # Chrome MV3 relay extension (pairing popup + watchdog)
prompts/                      # agent system-prompt templates (soul, default, plan, authflow)
scripts/
  setup.sh                    # provisions the API worker (secrets + deploy)
docs/
  PROJECT_PLAN.md             # the full design + recreation guide
  future-phases.md            # remaining phases
  REDESIGN.md                 # v1 redesign decisions
```

---

## 🛠 Tech stack

- **Cloudflare Workers** + **Durable Objects** (SQLite-backed persistence)
- **[`agents`](https://developers.cloudflare.com/agents/) SDK** — `getAgentByName`,
  `this.sql` tagged templates, `schedule()` + alarm-based self-healing, RPC
  decorator. *(Pre-1.0; some APIs are unstable and may require a cast.)*
- **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`)
- **Hono 4** — the API worker's HTTP router (pure REST + WS relay, no HTML)
- **TanStack Start** + **Vite 8** + **React 19** + **TanStack Query** — the
  standalone SSR frontend, deployed as its own Cloudflare Worker via
  `@cloudflare/vite-plugin`
- **Better Auth** — email/password + `emailOTP` (6-digit codes via Resend),
  cross-origin session cookie (`SameSite=None; Secure`)
- **Tailwind CSS v4** + **shadcn/ui** (`@agent-harness/ui`) — light theme,
  Geist + Open Sans, design tokens in `index.css`
- **dnd-kit** — kanban drag & drop (pointer + keyboard sensors)
- **react-markdown** — cover letter / tailored CV rendering (print-to-PDF via
  a print stylesheet)
- **unpdf + fflate** — CV text extraction (PDF / DOCX) inside the Worker
- **cron-parser** (schedule matching + missed-fire catch-up, pinned to UTC)
- **Zod** (tool parameter schemas)
- **Playwright** — the e2e suite (`packages/e2e`)

---

## 🧯 Safety & cost controls

The agent loop enforces multiple independent stop conditions:

1. **`finish` tool** — the LLM ends the run itself when the goal is met.
2. **`maxSteps`** — hard ceiling on LLM turns per run (default **100**).
3. **Token budget** — soft cumulative-token ceiling per run. ⚠️ **Defaults to 0
   (unlimited).** Set a sensible value (e.g. 500k) from the dashboard before
   trusting long runs.
4. **Idle detection** — consecutive turns with no tool call → stop.
5. **Repeated-loop detection** — same tool + identical args → stop.

Around that, a global **RateLimiter Durable Object** enforces: one active run
per user, a per-user LLM request window, and per-endpoint limits on sensitive
routes (CV upload 10/10min, pairing 5/h, cover letters and tailored CVs
10/min, browser probes 20/min).

**Browser guardrails (defense in depth):**
- **Code-level (authoritative):** login-wall detection (`observe()` returns
  `loginRequired` and the agent stops — it never types credentials), a domain
  allowlist, the origin guard for scraping-mode discovery, per-run action
  caps + navigation timeouts, and rate limits on pairing endpoints.
- **Prompt-level (advisory):** every `save_job` value must come from a page
  the agent actually opened; re-observe after every action; browse only for
  job-search purposes.

**Grounding guardrails:** the origin check refuses any URL not on an enabled
job source; jobs below a match threshold are dropped; duplicates deduped by
URL or company+title; CV tailoring may reorder and re-emphasize your real
history but never invent employers, dates, titles, or skills.

Remaining known gaps:

- CORS echoes only the two deployed origins (fine for this deployment shape;
  revisit before exposing the API more broadly).
- `GET /api/pipeline` has no pagination — very large pipelines will get heavy.
- Legacy binary `.doc` CVs aren't parseable (re-save as PDF/DOCX).

---

## 🧪 Testing

```bash
npm run typecheck        # frontend + worker
npm run test:unit        # worker unit tests (vitest, node pool)
npm --workspace @agent-harness/e2e run e2e:fast   # Playwright, skips @llm specs
npm --workspace @agent-harness/e2e run e2e        # full suite incl. real LLM runs
```

The e2e suite seeds its own users into local D1, boots both dev servers, and
covers signup/OTP, onboarding, the kanban (add → detail → advance → auto
follow-up → delete), drag & drop, settings round-trips, multi-tenant
isolation, and the REST contract. Set `E2E_OTP_BYPASS=1` in
`packages/hono-worker/.dev.vars` for deterministic OTPs — local dev only.

> The workers-vitest integration pool is currently blocked by a workers-sdk
> issue with spaces in the repo path (see
> `packages/hono-worker/src/test/integration/README.md`); unit + e2e are the
> active suites.

---

## 🤝 Contributing

Contributions are welcome! This is a small, focused project — please keep
changes consistent with the architecture described above.

1. Fork the repository and create a feature branch
   (`git checkout -b feat/my-change`).
2. Make your changes. Verify `npm run typecheck` and the test suites (see
   [Testing](#-testing)) before committing.
3. Open a pull request describing **what** changed and **why**.

### Areas that welcome help

- New job-source templates and site-specific fetch hardening.
- Vision-mode browser operation (screenshots + coordinate clicks) behind the
  LLM config flag.
- Pipeline pagination + saved board views.
- Additional LLM providers in `packages/hono-worker/src/config/llm-config.json`.

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

// =============================================================================
// Worker Entry Point — Hono router + scheduled watchdog
// =============================================================================
// All HTTP is served by a single Hono app:
//   GET  /                 → dashboard HTML (public)
//   /api/*                 → JSON API (CORS + Bearer-token auth via middleware)
//   WebSocket upgrades     → routed to Durable Object agents (routeAgentRequest)
//
// scheduled() is the cron watchdog that self-heals the Harness.
//
// v1 (Cloudflare FREE plan): Durable Objects + cron only — NO container/sandbox.
// =============================================================================

import { Hono } from "hono"
import { cors } from "hono/cors"

import { routeAgentRequest, getAgentByName } from "agents"
import type { Env } from "./types"
import type { AppEnv } from "./types/app-env"
import { Harness } from "./agents"

import { getAuth } from "./auth/session"
import { requireAuth } from "./auth/require-auth"
import {
  issueExtensionTokenRoute,
  userIdFromRelayRequest,
} from "./auth/extension-token"
import { renderer } from "./views/Layout"
import { renderPage } from "./views/renderDashboard"
import OverviewPage from "./views/pages/Overview"
import JobsPage from "./views/pages/Jobs"
import TracesPage from "./views/pages/Traces"
import TracePage from "./views/pages/Trace"
import LogsPage from "./views/pages/Logs"
import MemoryPage from "./views/pages/Memory"
import SettingsPage from "./views/pages/Settings"
import { getAgents, getHarnessForUser } from "./utils/get-agents"

// Re-export all Durable Object classes (required by Cloudflare)
export {
  Harness,
  JobApplicationAgent,
  BrowserRelay,
  BrowserAgent,
  RateLimiter,
} from "./agents"
// =============================================================================
// Hono app
// =============================================================================

const app = new Hono<AppEnv>()

// CORS on everything (preflight handled automatically by the middleware).
//
// The frontend is a STANDALONE app on a separate origin, so we can't use the
// wildcard "*" — browsers refuse to send credentials (the session cookie) when
// Access-Control-Allow-Origin is the literal "*" AND credentials are involved.
// Instead we echo the request Origin back iff it's in the allowlist (the
// frontend origin + the API origin itself). `credentials: true` sets
// Access-Control-Allow-Credentials so the cookie rides along cross-origin.
app.use(
  "*",
  async (c, next) => {
    const allowed = new Set(
      [c.env.FRONTEND_URL, c.env.BETTER_AUTH_URL].filter(
        (o): o is string => typeof o === "string" && o.length > 0,
      ),
    )
    const corsMiddleware = cors({
      origin: (origin) => (origin && allowed.has(origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Set-Cookie"],
    })
    return corsMiddleware(c, next)
  },
)

// ── Better Auth handler ──────────────────────────────────────────────────
// Better Auth's handler owns the full request/response for its routes
// (sign-in, callback, session, sign-out, etc.). Mounted before requireAuth so
// the auth endpoints are reachable without a session. The instance is built
// per-request from env so baseURL resolves to the real request host.
//
// Better Auth's internal router (better-call) swallows unhandled errors into
// empty-body 500s, which are hard to diagnose. We wrap the handler so any 5xx
// is logged with the route for visibility in `wrangler tail` / the dev console.
app.on(["GET", "POST"], "/api/auth/*", async c => {
  const auth = getAuth(c)
  const res = await auth.handler(c.req.raw)
  if (res.status >= 500) {
    console.error(
      `[auth] ${c.req.method} ${c.req.path} → ${res.status}`,
    )
  }
  return res
})

// ── Session-cookie auth on everything ────────────────────────────────────
// Replaces the legacy shared bearer token. requireAuth reads the Better Auth
// session cookie, redirects HTML requests to /login (or 401s JSON), and on
// success sets c.var.session + c.var.userId. Exempt paths: /api/auth/*,
// /login, /signup, static assets, /browser/relay (auth'd via extension token).
app.use("*", requireAuth)

// ── Login page ───────────────────────────────────────────────────────────
// Minimal email → magic-link form. Exempt from requireAuth (see above). The
// form POSTs to Better Auth's magic-link endpoint (/api/auth/magic-link/sign-
// in) which sends the link and returns here. The full login UI ships with the
// Vite frontend in Stage 8; this is the functional placeholder.
app.get("/login", c =>
  c.html(LOGIN_PAGE_HTML),
)

// ── Vite SPA entry point ─────────────────────────────────────────────────
// The new Vite + @tanstack/react-router frontend. Built into ./public/app/
// (see frontend/vite.config.ts) and served via the ASSETS binding. The SPA
// uses hash-based routing, so this single entry covers all client routes
// (#/jobs, #/traces, etc.). Exempt from requireAuth (the SPA does its own
// auth guards client-side; the /api calls it makes are still session-gated).
app.get("/app", async c => {
  const asset = await c.env.ASSETS.fetch(new URL("/app/index.html", c.req.url))
  return new Response(asset.body, asset)
})
app.get("/app/*splat", async c => {
  // Serve any built asset under /app/ (JS/CSS chunks) directly from ASSETS.
  const asset = await c.env.ASSETS.fetch(new URL(c.req.path, c.req.url))
  return new Response(asset.body, asset)
})
const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1e293b;padding:40px;border-radius:16px;max-width:380px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
  h1{margin:0 0 8px;font-size:24px;font-weight:700}
  p{color:#94a3b8;margin:0 0 24px;font-size:14px}
  label{display:block;font-size:13px;color:#cbd5e1;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:16px}
  button{width:100%;padding:12px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  .msg{margin-top:16px;padding:12px;border-radius:8px;font-size:14px;display:none}
  .msg.ok{background:#064e3b;color:#6ee7b7;display:block}
  .msg.err{background:#7f1d1d;color:#fca5a5;display:block}
</style>
</head>
<body>
<form class="card" id="login-form">
  <h1>Sign in</h1>
  <p>Enter your email and we'll send a magic link.</p>
  <label for="email">Email</label>
  <input type="email" id="email" name="email" required autocomplete="email" autofocus />
  <button type="submit">Send magic link</button>
  <div class="msg" id="msg"></div>
</form>
<script>
const form = document.getElementById('login-form');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  msg.className = 'msg';
  msg.textContent = 'Sending...';
  try {
    const res = await fetch('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ email, callbackURL: '/' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'Failed');
    msg.className = 'msg ok';
    // Better Auth returns the link in dev (no email provider). Show it.
    msg.textContent = data?.url
      ? 'Dev mode — click this link: ' + data.url
      : 'Check your email for the sign-in link.';
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});
</script>
</body>
</html>`

// ── Onboarding page + completion endpoint ────────────────────────────────
// A user who hasn't completed profile + CV setup is redirected here by the
// onboarding gate. This is the functional placeholder; the full onboarding UI
// ships with the Vite frontend in Stage 8. The completion endpoint writes the
// profile + marks onboarding_complete = 1 in D1.
app.get("/onboarding", c => c.html(ONBOARDING_PAGE_HTML))

app.post("/api/onboarding", async c => {
  const userId = c.var.userId
  const body = await c.req.json().catch(() => ({}))

  // Persist the profile fields to the user's JobApplicationAgent.
  const { jobAgent } = await getAgents(c.env, userId)
  const profilePatch: Record<string, string> = {}
  for (const k of [
    "fullName",
    "email",
    "phone",
    "location",
    "links",
    "workAuth",
    "seniority",
    "yearsExperience",
    "targetRoles",
    "targetLocations",
    "skills",
    "preferences",
    "workMode",
    "jobSearchStatus",
    "linkedinUrl",
    "githubUrl",
    "portfolioUrl",
  ]) {
    if (typeof (body as any)[k] === "string") profilePatch[k] = (body as any)[k]
  }
  if (Object.keys(profilePatch).length > 0) {
    await jobAgent.setProfile(profilePatch)
  }

  // Mark onboarding complete in D1. The user can edit their profile later via
  // PUT /api/profile; this flag just unlocks the rest of the app.
  // Columns are camelCase to match migrations/0002_camelcase.sql (Better Auth
  // 1.6.x queries camelCase at runtime).
  try {
    await c.env.DB.prepare(
      `UPDATE "user" SET onboardingComplete = 1, updatedAt = ? WHERE id = ?`,
    )
      .bind(Date.now(), userId)
      .run()
  } catch (error: any) {
    return c.json({ error: `Failed to mark onboarding: ${error.message}` }, 500)
  }

  return c.json({ message: "Onboarding complete", redirect: "/" })
})

const ONBOARDING_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Complete your profile</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
  .wrap{max-width:560px;margin:0 auto}
  h1{font-size:24px;margin:0 0 8px}
  p.sub{color:#94a3b8;margin:0 0 24px;font-size:14px}
  .field{margin-bottom:16px}
  label{display:block;font-size:13px;color:#cbd5e1;margin-bottom:6px}
  input,textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:14px}
  textarea{min-height:60px;resize:vertical}
  button{padding:12px 24px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  .msg{margin-top:16px;padding:12px;border-radius:8px;font-size:14px;display:none}
  .msg.ok{background:#064e3b;color:#6ee7b7;display:block}
  .msg.err{background:#7f1d1d;color:#fca5a5;display:block}
</style>
</head>
<body>
<form class="wrap" id="ob-form">
  <h1>Complete your profile</h1>
  <p class="sub">This info powers your job search agent. You can edit it later in Settings.</p>
  <div class="field"><label>Full name</label><input id="fullName" required /></div>
  <div class="field"><label>Email</label><input id="email" type="email" required /></div>
  <div class="field"><label>Phone</label><input id="phone" /></div>
  <div class="field"><label>Location</label><input id="location" /></div>
  <div class="field"><label>Target roles</label><input id="targetRoles" placeholder="e.g. Senior TypeScript Engineer" /></div>
  <div class="field"><label>Target locations</label><input id="targetLocations" placeholder="e.g. Remote, London" /></div>
  <div class="field"><label>Skills (comma-separated)</label><textarea id="skills"></textarea></div>
  <div class="field"><label>Work authorization</label><input id="workAuth" placeholder="e.g. EU citizen, requires sponsorship" /></div>
  <div class="field"><label>CV upload (PDF/DOCX)</label><input id="cv-file" type="file" accept=".pdf,.doc,.docx" /></div>
  <button type="submit">Complete setup</button>
  <div class="msg" id="msg"></div>
</form>
<script>
const form = document.getElementById('ob-form');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg';
  msg.textContent = 'Saving...';
  try {
    // 1. Upload CV if selected (R2).
    const fileInput = document.getElementById('cv-file');
    if (fileInput.files[0]) {
      const f = fileInput.files[0];
      const upRes = await fetch('/api/profile/cv?filename=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: {'Content-Type': f.type},
        body: f
      });
      if (!upRes.ok) throw new Error('CV upload failed');
    }
    // 2. Save profile fields + mark onboarding complete.
    const body = {
      fullName: document.getElementById('fullName').value,
      email: document.getElementById('email').value,
      phone: document.getElementById('phone').value,
      location: document.getElementById('location').value,
      targetRoles: document.getElementById('targetRoles').value,
      targetLocations: document.getElementById('targetLocations').value,
      skills: document.getElementById('skills').value,
      workAuth: document.getElementById('workAuth').value,
    };
    const res = await fetch('/api/onboarding', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Failed');
    window.location.href = '/';
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});
</script>
</body>
</html>`

// =============================================================================
// Pages — each route is its own URL, server-renders only what that page needs.
// The browser's back/forward + Cmd-click-into-new-tab work for free because
// these are real HTTP routes with real URLs (Vercel Web Interface Guidelines:
// "links use <a>/<Link>", "URL reflects state").
//
// ROUTE SHAPE NOTE: Each page route is `app.get(path, renderer, handler)`.
// Hono's jsxRenderer is a route-level middleware — it MUST be attached inline
// per route (or to a sub-app via app.route()) to set up `c.render()`. Putting
// it on `app.use()` does NOT reliably fire for GET handlers in current Hono
// version — the renderer must run before the handler so c.render exists,
// and the per-route `app.get(path, renderer, handler)` form is the
// documented pattern (cf. https://hono.dev/docs/middleware/builtin/jsx-renderer).
// =============================================================================

// ── Public marketing landing page (SPA shell) ────────────────────────────
// `/` is the front door: it serves the Vite SPA's index.html via the ASSETS
// binding. The SPA's hash router shows the public LandingPage at `#/` for
// logged-out visitors and redirects to `#/dashboard` for logged-in ones.
// Auth-gating happens client-side; the Worker keeps `/` public (see
// require-auth.ts PUBLIC_PREFIXES) so unauthenticated visitors see marketing.
app.get("/", async c => {
  const asset = await c.env.ASSETS.fetch(new URL("/app/index.html", c.req.url))
  return new Response(asset.body, asset)
})

// ── Legacy SSR dashboard (Overview) ──────────────────────────────────────
// The server-rendered overview moved off `/` (now the marketing page) to
// `/legacy` so the SPA is the primary UI. Kept for reference/fallback; the
// other SSR pages (/jobs, /traces, …) stay at their original paths.
app.get("/legacy", renderer, async c => {
  const { harness, jobAgent } = await getAgents(c.env, c.var.userId)
  // The overview is job-first: pipeline stats + listings + follow-ups are the
  // primary data; agent status + token trend are demoted to the bottom. Each
  // fetch is independently guarded so one slow/failing DO call doesn't blank
  // the whole page.
  const [status, turns, tokensByDay, summaries, pipeline, followUps] =
    await Promise.all([
      harness.getFullStatus().catch(() => null),
      harness.getTurnTokenStats().catch(() => null),
      harness.getTokensByDay(14).catch(() => []),
      harness.getDailySummaries(5).catch(() => []),
      jobAgent.getPipeline().catch(() => ({
        listings: [],
        stats: { total: 0, byStatus: {}, dueFollowUps: 0 },
      })),
      jobAgent.getDueFollowUps().catch(() => []),
    ])
  return renderPage(c, "overview", OverviewPage, {
    status,
    turns,
    tokensByDay,
    summaries,
    pipeline,
    followUps,
  })
})

app.get("/jobs", renderer, async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  let pipeline: {
    listings: any[]
    stats: { total: number; byStatus: Record<string, number> }
  } = { listings: [], stats: { total: 0, byStatus: {} } }
  try {
    pipeline = await jobAgent.getPipeline()
  } catch (_) {}
  return renderPage(c, "jobs", JobsPage, {
    listings: pipeline.listings ?? [],
    stats: pipeline.stats,
  })
})

app.get("/traces", renderer, async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  let runs: any[] = []
  try {
    runs = await harness.listRuns(30)
  } catch (_) {}
  return renderPage(c, "traces", TracesPage, { runs })
})

// Deep-linkable single-run transcript. A real route (not a JS-only sheet) so
// Cmd-click opens a new tab and the back button returns to the run list. The
// page server-renders the run header; the heavy event stream is hydrated
// client-side from /api/runs/:runId (which returns run + events in one call).
app.get("/traces/:runId", renderer, async c => {
  const runId = c.req.param("runId")
  const { harness } = await getAgents(c.env, c.var.userId)
  let run: any = null
  try {
    run = await harness.getRun(runId)
  } catch (_) {}
  return renderPage(c, "traces", TracePage, { runId, run })
})

app.get("/logs", renderer, async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  let log: any[] = []
  try {
    log = await harness.getLog(50)
  } catch (_) {}
  return renderPage(c, "logs", LogsPage, { log })
})

app.get("/memory", renderer, async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const [userMemory, agentMemory] = await Promise.all([
    harness.getAllUserMemory().catch(() => []),
    harness.getAllMemory().catch(() => []),
  ])
  return renderPage(c, "memory", MemoryPage, { userMemory, agentMemory })
})

app.get("/settings", renderer, async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const [config, schedules] = await Promise.all([
    harness.getConfig().catch(() => ({})),
    harness.listAppSchedules().catch(() => []),
  ])
  return renderPage(c, "settings", SettingsPage, { config, schedules })
})

// =============================================================================
// Status & Control
// =============================================================================
// Browser capability — relay WebSocket upgrade + status/control API.
// =============================================================================
// The Chrome extension connects its OUTBOUND WebSocket to /browser/relay
// (the Worker can't reach a browser behind NAT; the browser reaches us). That
// WS is what lets the agent drive the user's real, logged-in Chrome for
// login-walled job sites. See docs/browser-cdp-guide.md.

app.all("/browser/relay", async c => {
  // The extension can't send a session cookie on a WS upgrade, so the relay
  // identifies the user via a signed extension token on the URL
  // (?token=<jwt>). The dashboard mints the token against the session user
  // (POST /api/browser/extension-token); the extension stores it and appends
  // it on connect. This is the ONLY way the Worker knows which per-user relay
  // DO to route the socket to.
  const url = new URL(c.req.url)
  const userId = await userIdFromRelayRequest(url, c.env.AUTH_SECRET)
  if (!userId) {
    return c.json({ error: "Missing or invalid extension token" }, 401)
  }
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, userId)
  return relay.fetch(c.req.raw)
})

// Mint an extension token for the session user (the dashboard surfaces it for
// the extension to copy/store). Session-gated by requireAuth.
app.post("/api/browser/extension-token", issueExtensionTokenRoute)

app.get("/api/browser/status", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, c.var.userId)
  return c.json(await relay.statusSnapshot())
})

app.post("/api/browser/disconnect", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, c.var.userId)
  return c.json({ disconnected: relay.disconnectLive() })
})

// Manual test harness — navigate + observe a URL through the connected browser
// and return the raw result. Backs the Browser Test panel on Settings. Lets the
// operator verify the whole chain (relay → extension → Chrome → CDP) without a
// full agent run. No LLM call, so it's free to run repeatedly.
app.post("/api/browser/probe", async c => {
  const body = await c.req.json().catch(() => ({}))
  if (!body?.url) return c.json({ error: "url required" }, 400)
  const agent: any = await getAgentByName(c.env.BROWSER_AGENT, c.var.userId)
  return c.json(await agent.probe(body.url))
})

// =============================================================================

app.get("/api/status", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getFullStatus())
})

app.post("/api/start", async c => {
  const body = await c.req.json().catch(() => ({}))
  const { harness } = await getAgents(c.env, c.var.userId)
  // Pass the session userId so the harness persists it + threads it through
  // buildAgentTools → every delegating tool resolves sub-agents by this user.
  return c.json({ message: await harness.start(body.goal, c.var.userId) })
})

app.post("/api/stop", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.stop() })
})

app.post("/api/pause", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.pause() })
})

app.post("/api/resume", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.resume() })
})

// =============================================================================
// Config
// =============================================================================

app.get("/api/config", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getConfig())
})

app.put("/api/config", async c => {
  const body = await c.req.json()
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.updateConfig(body) })
})

// =============================================================================
// Schedules
// =============================================================================

app.get("/api/schedules", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.listAppSchedules())
})

app.post("/api/schedules", async c => {
  const body = await c.req.json()
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.addSchedule(body.cron, body.focus ?? "all"),
  })
})

app.delete("/api/schedules/:id", async c => {
  const id = Number(c.req.param("id"))
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.removeSchedule(id) })
})

app.put("/api/schedules/:id/toggle", async c => {
  const id = Number(c.req.param("id"))
  const body = await c.req.json()
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.toggleSchedule(id, body.enabled) })
})

// =============================================================================
// Logs & Summaries
// =============================================================================

app.get("/api/log", async c => {
  const limit = Number(c.req.query("limit") ?? "50")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getLog(limit))
  } catch (e: any) {
    console.error("[/api/log] THREW:", e?.stack ?? e)
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.get("/api/summaries", async c => {
  const limit = Number(c.req.query("limit") ?? "10")
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getDailySummaries(limit))
})

// =============================================================================
// Trace — model thinking + per-step usage breakdown
// =============================================================================
// Backs the Trace tab. listRuns() populates the run picker; getTrace(runId)
// returns the ordered step list with reasoning, text, usage, duration.
// =============================================================================

app.get("/api/runs", async c => {
  const limit = Number(c.req.query("limit") ?? "20")
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.listRuns(limit))
})

app.get("/api/run/:runId/trace", async c => {
  const runId = c.req.param("runId")
  if (!runId) return c.json({ error: "runId required" }, 400)
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getTrace(runId))
})

// =============================================================================
// Memory — the harness's remembered facts (the `context` table)
// =============================================================================
// These rows back the Memory tab. The harness already has read/write via the
// `remember` / `recall` tools the LLM calls; these routes expose the same
// rows to the dashboard for human inspection and editing.
// =============================================================================

app.get("/api/memory", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getAllMemory())
})

app.put("/api/memory", async c => {
  const body = await c.req.json()
  if (!body?.key || typeof body.key !== "string") {
    return c.json({ error: "key required" }, 400)
  }
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.setMemory(body.key, String(body.value ?? "")),
  })
})

app.delete("/api/memory/:key", async c => {
  const key = decodeURIComponent(c.req.param("key"))
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.forgetMemory(key) })
})

// =============================================================================
// User memory — human-authored notes injected into every system prompt
// =============================================================================
// Distinct from /api/memory (the agent's own recalled facts). These are the
// operator's notes — higher authority than the agent's recall.
// =============================================================================

app.get("/api/user-memory", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getAllUserMemory())
})

app.put("/api/user-memory", async c => {
  const body = await c.req.json()
  if (!body?.key || typeof body.key !== "string") {
    return c.json({ error: "key required" }, 400)
  }
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.setUserMemory(body.key, String(body.value ?? "")),
  })
})

app.delete("/api/user-memory/:key", async c => {
  const key = decodeURIComponent(c.req.param("key"))
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.forgetUserMemory(key) })
})

// =============================================================================
// Goals — the prominent platform. Set/read the active goal.
// =============================================================================

app.get("/api/goal", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const status = await harness.getFullStatus()
  return c.json({ goal: status.goal })
})

app.put("/api/goal", async c => {
  const body = await c.req.json()
  if (typeof body?.goal !== "string") {
    return c.json({ error: "goal string required" }, 400)
  }
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.setGoal(body.goal) })
})

app.post("/api/goal/synthesize", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const goal = await harness.synthesizeGoalFromCapabilities()
  return c.json({ goal })
})

// =============================================================================
// Plan — structured execution plan for the current/next run
// =============================================================================

app.get("/api/plan", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json({ plan: await harness.getPlan() })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.post("/api/plan/advance", async c => {
  const body = await c.req.json().catch(() => ({}))
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    const plan = await harness.advancePlan(
      body.stepId ?? null,
      body.status ?? "complete",
      body.result ?? null,
    )
    return c.json({ plan })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// =============================================================================
// Trace events — append-only event log backing Traces + Logs pages
// =============================================================================
// getTraceEvents(runId) returns the ordered stream of events for a single run:
// run_start, system (full prompt), prompt, reasoning, text, tool_call,
// tool_result, step_end, run_end. This is what the TraceSheet renders.
//
// /api/runs/:runId/live is the SSE-ish long-poll endpoint: pass ?sinceSeq=N,
// get back events with seq > N. The dashboard polls every ~2s while a run is
// active to render the "what is the model working on right now" panel.
// =============================================================================

app.get("/api/runs/:runId/events", async c => {
  const runId = c.req.param("runId")
  const sinceSeq = Number(c.req.query("sinceSeq") ?? "0")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTraceEvents(runId, sinceSeq))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Single run: metadata + ordered events in ONE payload. The transcript page
// hydrates from this (one round trip) instead of two separate calls. Events
// already carry the v2 columns (agent, toolCallId, parentId, parentLabel,
// cacheRead/Write, truncated) the transcript renderer needs.
app.get("/api/runs/:runId", async c => {
  const runId = c.req.param("runId")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    const [run, events] = await Promise.all([
      harness.getRun(runId),
      harness.getTraceEvents(runId, 0, 2000),
    ])
    return c.json({ run, events })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Model probe — sends a canned tiny request to the configured model and
// returns the RAW shapes (response.messages, full usage incl. cache +
// reasoning details, response.headers, providerMetadata, finishReason). The
// "learn what each model returns" lever: run this after switching providers
// to see exactly what the trace renderer will be working with.
app.get("/api/debug/model-probe", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    // Cast to any: probeModel's return type (with the model-info union) can
    // push Hono's c.json() type instantiation past its depth limit.
    return c.json((await harness.probeModel()) as any)
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// DEBUG: validate the current checkpoint's messages against the AI SDK v7
// ModelMessage[] schema. Returns the exact field that fails. Used to diagnose
// "messages do not match the ModelMessage[] schema" without guessing.
app.get("/api/debug/validate-messages", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json((await (harness as any).debugValidateMessages()) as any)
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.get("/api/trace-events", async c => {
  const limit = Number(c.req.query("limit") ?? "200")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getRecentTraceEvents(limit))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Token spend grouped by day — bars for the Overview chart.
app.get("/api/tokens-by-day", async c => {
  const days = Number(c.req.query("days") ?? "14")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTokensByDay(days))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Per-turn output token stats — drives the Overview "Output tokens / turn" card.
app.get("/api/turn-tokens", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTurnTokenStats())
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Notifications — recent operator-relevant happenings for the bell dropdown.
app.get("/api/notifications", async c => {
  const limit = Number(c.req.query("limit") ?? "12")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getRecentNotifications(limit))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Single job detail — listing + cover letters + follow-ups. Backs the Kanban
// card → Sheet drawer.
app.get("/api/jobs/:id", async c => {
  const jobId = Number(c.req.param("id"))
  if (!Number.isFinite(jobId)) return c.json({ error: "invalid id" }, 400)
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await jobAgent.getJob(jobId))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// =============================================================================
// Job Pipeline
// =============================================================================

app.get("/api/pipeline", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getPipeline())
})

// =============================================================================
// Job sources — operator-configured job websites the agent is allowed to browse.
// CRUD routes backing the dashboard's "Sources" management UI. The agent's
// search tools read the same `job_sources` table at runtime to scope every
// fetch_page / search_site to an enabled source's origin.
// =============================================================================

app.get("/api/job-sources", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.listJobSources())
})

app.post("/api/job-sources", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.addJobSource(body))
})

app.put("/api/job-sources/:id", async c => {
  const id = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.updateJobSource(id, body),
  })
})

app.delete("/api/job-sources/:id", async c => {
  const id = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.removeJobSource(id) })
})

app.post("/api/jobs", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.addJob(body))
})

app.post("/api/jobs/:id/cover-letter", async c => {
  const jobId = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.generateCoverLetter({ jobId }))
})

app.get("/api/jobs/:id/cover-letters", async c => {
  const jobId = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getCoverLettersForJob(jobId))
})

app.put("/api/jobs/:id/status", async c => {
  const jobId = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.updateStatus({
      jobId,
      status: body.status,
      notes: body.notes,
    }),
  })
})

app.delete("/api/jobs/:id", async c => {
  const jobId = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.deleteJob({ jobId }) })
})

app.post("/api/jobs/:id/follow-up", async c => {
  const jobId = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.addFollowUp({
      jobId,
      dueDate: body.dueDate,
      note: body.note,
    }),
  })
})

// =============================================================================
// Profile
// =============================================================================

app.get("/api/profile", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getProfile())
})

app.put("/api/profile", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.setProfile(body) })
})

// CV file upload — stores the bytes in R2 (keyed by userId), and writes only a
// metadata pointer {r2Key, filename, contentType} into the user's profile.
// The bytes never touch SQLite. Cap raised to 10 MB for real PDFs/DOCX.
app.post("/api/profile/cv", async c => {
  const userId = c.var.userId
  const { jobAgent } = await getAgents(c.env, userId)
  const filename = c.req.query("filename") || "cv"
  const contentType = c.req.header("Content-Type") || "application/octet-stream"
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > 10 * 1024 * 1024) {
    return c.json({ error: "File too large (max 10 MB)" }, 413)
  }
  const r2Key = `cvs/${userId}/${crypto.randomUUID()}`
  await c.env.CV_BUCKET.put(r2Key, raw, {
    httpMetadata: { contentType },
  })
  // Store the pointer (NOT the bytes) in the profile kv table.
  await jobAgent.setProfile({
    cv: JSON.stringify({ r2Key, filename, contentType }),
    cvFilename: filename,
    cvContentType: contentType,
    cvR2Key: r2Key,
    cvUploadedAt: new Date().toISOString(),
  })
  return c.json({
    message: `CV uploaded (${filename}, ${raw.byteLength} bytes)`,
    r2Key,
    filename,
    contentType,
  })
})

// CV download — streams the file back from R2 (attachment). Lets the user
// retrieve their uploaded CV and lets operators verify uploads.
app.get("/api/profile/cv", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  const profile = await jobAgent.getProfile()
  if (!profile.cvR2Key) {
    return c.json({ error: "No CV uploaded" }, 404)
  }
  const obj = await c.env.CV_BUCKET.get(profile.cvR2Key)
  if (!obj) {
    return c.json({ error: "CV file not found in storage" }, 404)
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(profile.cvFilename ?? "cv")}"`,
  )
  return new Response(obj.body, { headers })
})

// =============================================================================
// Follow-ups
// =============================================================================

app.get("/api/follow-ups", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getDueFollowUps())
})

// =============================================================================
// Main Worker export
// =============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Try the Hono app (dashboard + /api/* + everything else it defines).
    const honoResponse = await app.fetch(request, env as any)
    if (honoResponse.status !== 404) return honoResponse

    // 2. Agent WebSocket routing (for real-time DO connections) — only runs
    //    when Hono didn't match (it returns 404 for unknown routes).
    const agentResponse = await routeAgentRequest(request, env)
    if (agentResponse) return agentResponse

    // 3. Final fallback.
    return new Response("Not found", { status: 404 })
  },

  // Cron watchdog — multi-tenant with per-user staggering.
  //
  // Enumerates every user from D1 and wakes EACH user's harness. The harness
  // inspects its own state and decides internally whether a run is due (the
  // Managed Agents "wake(sessionId)" shape). Per-user try/catch so one failing
  // user's harness doesn't block the others.
  //
  // STAGGERING: wakes are spread across the 2-minute cron window using a
  // deterministic per-user offset (a hash of the userId % 120s → setTimeout).
  // This prevents N users from all firing their first LLM call in the same
  // tick, which would hammer the shared LLM_API_KEY's rate limit.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    let users: { id: string }[] = []
    try {
      const result = await env.DB.prepare("SELECT id FROM user").all<{
        id: string
      }>()
      users = result.results ?? []
    } catch (error: any) {
      console.error("[watchdog] failed to enumerate users:", error.message)
      return
    }

    const STAGGER_WINDOW_MS = 120_000 // the cron runs every 2 minutes
    for (const u of users) {
      // Deterministic offset: a simple string hash of the userId, modulo the
      // window. The same user always gets the same offset, so their wake time
      // is stable across ticks.
      const offset =
        Array.from(u.id).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0) %
        STAGGER_WINDOW_MS
      const absOffset = Math.abs(offset)
      setTimeout(() => {
        getHarnessForUser(env, u.id)
          .then(harness => harness.wake())
          .then(result => {
            if (result.ran) {
              console.log(`[watchdog] user ${u.id} wake → ${result.reason}`)
            }
          })
          .catch((error: any) => {
            // One user's failure must not stop the rest.
            console.error(
              `[watchdog] user ${u.id} wake error:`,
              error.message,
            )
          })
      }, absOffset)
    }
  },
}

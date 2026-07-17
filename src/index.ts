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
import { bearerAuth } from "hono/bearer-auth"

import { routeAgentRequest, getAgentByName } from "agents"
import type { Env } from "./types"
import { Harness } from "./agents"

import { renderer } from "./views/Layout"
import { renderPage } from "./views/renderDashboard"
import OverviewPage from "./views/pages/Overview"
import JobsPage from "./views/pages/Jobs"
import TracesPage from "./views/pages/Traces"
import TracePage from "./views/pages/Trace"
import LogsPage from "./views/pages/Logs"
import MemoryPage from "./views/pages/Memory"
import SettingsPage from "./views/pages/Settings"
import { getAgents, HARNESS_ID } from "./utils/get-agents"

// Re-export all Durable Object classes (required by Cloudflare)
export {
  Harness,
  ResearchAgent,
  JobApplicationAgent,
  BrowserRelay,
  BrowserAgent,
} from "./agents"
// =============================================================================
// Hono app
// =============================================================================

const app = new Hono<{ Bindings: Env }>()

// CORS on everything (preflight handled automatically by the middleware).
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

// Bearer-token auth on the JSON API only. The HTML routes intentionally stay
// public — the dashboard prompts for the token client-side on first visit,
// and every data-fetching route is under /api/* where this middleware applies.
app.use(
  "/api/*",
  bearerAuth<{ Bindings: Env }>({
    verifyToken: async (token, c) => {
      const TOKEN = c.env?.DASHBOARD_TOKEN
      return token === TOKEN
    },
  }),
)

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

app.get("/", renderer, async c => {
  const { harness, jobAgent } = await getAgents(c.env)
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
  const { jobAgent } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
  let run: any = null
  try {
    run = await harness.getRun(runId)
  } catch (_) {}
  return renderPage(c, "traces", TracePage, { runId, run })
})

app.get("/logs", renderer, async c => {
  const { harness } = await getAgents(c.env)
  let log: any[] = []
  try {
    log = await harness.getLog(50)
  } catch (_) {}
  return renderPage(c, "logs", LogsPage, { log })
})

app.get("/memory", renderer, async c => {
  const { harness } = await getAgents(c.env)
  const [userMemory, agentMemory] = await Promise.all([
    harness.getAllUserMemory().catch(() => []),
    harness.getAllMemory().catch(() => []),
  ])
  return renderPage(c, "memory", MemoryPage, { userMemory, agentMemory })
})

app.get("/settings", renderer, async c => {
  const { harness } = await getAgents(c.env)
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
  // Forward the WS upgrade straight to the relay DO. The relay accepts +
  // hibernates the socket and tags it for its webSocketMessage handler.
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, "main")
  return relay.fetch(c.req.raw)
})

app.get("/api/browser/status", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, "main")
  return c.json(await relay.statusSnapshot())
})

app.post("/api/browser/disconnect", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, "main")
  return c.json({ disconnected: relay.disconnectLive() })
})

// Manual test harness — navigate + observe a URL through the connected browser
// and return the raw result. Backs the Browser Test panel on Settings. Lets the
// operator verify the whole chain (relay → extension → Chrome → CDP) without a
// full agent run. No LLM call, so it's free to run repeatedly.
app.post("/api/browser/probe", async c => {
  const body = await c.req.json().catch(() => ({}))
  if (!body?.url) return c.json({ error: "url required" }, 400)
  const agent: any = await getAgentByName(c.env.BROWSER_AGENT, "main")
  return c.json(await agent.probe(body.url))
})

// =============================================================================

app.get("/api/status", async c => {
  const { harness } = await getAgents(c.env)
  return c.json(await harness.getFullStatus())
})

app.post("/api/start", async c => {
  const body = await c.req.json().catch(() => ({}))
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.start(body.goal) })
})

app.post("/api/stop", async c => {
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.stop() })
})

app.post("/api/pause", async c => {
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.pause() })
})

app.post("/api/resume", async c => {
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.resume() })
})

// =============================================================================
// Config
// =============================================================================

app.get("/api/config", async c => {
  const { harness } = await getAgents(c.env)
  return c.json(await harness.getConfig())
})

app.put("/api/config", async c => {
  const body = await c.req.json()
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.updateConfig(body) })
})

// =============================================================================
// Schedules
// =============================================================================

app.get("/api/schedules", async c => {
  const { harness } = await getAgents(c.env)
  return c.json(await harness.listAppSchedules())
})

app.post("/api/schedules", async c => {
  const body = await c.req.json()
  const { harness } = await getAgents(c.env)
  return c.json({
    message: await harness.addSchedule(body.cron, body.focus ?? "all"),
  })
})

app.delete("/api/schedules/:id", async c => {
  const id = Number(c.req.param("id"))
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.removeSchedule(id) })
})

app.put("/api/schedules/:id/toggle", async c => {
  const id = Number(c.req.param("id"))
  const body = await c.req.json()
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.toggleSchedule(id, body.enabled) })
})

// =============================================================================
// Logs & Summaries
// =============================================================================

app.get("/api/log", async c => {
  const limit = Number(c.req.query("limit") ?? "50")
  const { harness } = await getAgents(c.env)
  try {
    return c.json(await harness.getLog(limit))
  } catch (e: any) {
    console.error("[/api/log] THREW:", e?.stack ?? e)
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.get("/api/summaries", async c => {
  const limit = Number(c.req.query("limit") ?? "10")
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
  return c.json(await harness.listRuns(limit))
})

app.get("/api/run/:runId/trace", async c => {
  const runId = c.req.param("runId")
  if (!runId) return c.json({ error: "runId required" }, 400)
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
  return c.json(await harness.getAllMemory())
})

app.put("/api/memory", async c => {
  const body = await c.req.json()
  if (!body?.key || typeof body.key !== "string") {
    return c.json({ error: "key required" }, 400)
  }
  const { harness } = await getAgents(c.env)
  return c.json({
    message: await harness.setMemory(body.key, String(body.value ?? "")),
  })
})

app.delete("/api/memory/:key", async c => {
  const key = decodeURIComponent(c.req.param("key"))
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.forgetMemory(key) })
})

// =============================================================================
// User memory — human-authored notes injected into every system prompt
// =============================================================================
// Distinct from /api/memory (the agent's own recalled facts). These are the
// operator's notes — higher authority than the agent's recall.
// =============================================================================

app.get("/api/user-memory", async c => {
  const { harness } = await getAgents(c.env)
  return c.json(await harness.getAllUserMemory())
})

app.put("/api/user-memory", async c => {
  const body = await c.req.json()
  if (!body?.key || typeof body.key !== "string") {
    return c.json({ error: "key required" }, 400)
  }
  const { harness } = await getAgents(c.env)
  return c.json({
    message: await harness.setUserMemory(body.key, String(body.value ?? "")),
  })
})

app.delete("/api/user-memory/:key", async c => {
  const key = decodeURIComponent(c.req.param("key"))
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.forgetUserMemory(key) })
})

// =============================================================================
// Goals — the prominent platform. Set/read the active goal.
// =============================================================================

app.get("/api/goal", async c => {
  const { harness } = await getAgents(c.env)
  const status = await harness.getFullStatus()
  return c.json({ goal: status.goal })
})

app.put("/api/goal", async c => {
  const body = await c.req.json()
  if (typeof body?.goal !== "string") {
    return c.json({ error: "goal string required" }, 400)
  }
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.setGoal(body.goal) })
})

app.post("/api/goal/synthesize", async c => {
  const { harness } = await getAgents(c.env)
  const goal = await harness.synthesizeGoalFromCapabilities()
  return c.json({ goal })
})

// =============================================================================
// Plan — structured execution plan for the current/next run
// =============================================================================

app.get("/api/plan", async c => {
  const { harness } = await getAgents(c.env)
  try {
    return c.json({ plan: await harness.getPlan() })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.post("/api/plan/advance", async c => {
  const body = await c.req.json().catch(() => ({}))
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
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
  const { harness } = await getAgents(c.env)
  try {
    // Cast to any: probeModel's return type (with the model-info union) can
    // push Hono's c.json() type instantiation past its depth limit.
    return c.json((await harness.probeModel()) as any)
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.get("/api/trace-events", async c => {
  const limit = Number(c.req.query("limit") ?? "200")
  const { harness } = await getAgents(c.env)
  try {
    return c.json(await harness.getRecentTraceEvents(limit))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Token spend grouped by day — bars for the Overview chart.
app.get("/api/tokens-by-day", async c => {
  const days = Number(c.req.query("days") ?? "14")
  const { harness } = await getAgents(c.env)
  try {
    return c.json(await harness.getTokensByDay(days))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Per-turn output token stats — drives the Overview "Output tokens / turn" card.
app.get("/api/turn-tokens", async c => {
  const { harness } = await getAgents(c.env)
  try {
    return c.json(await harness.getTurnTokenStats())
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Notifications — recent operator-relevant happenings for the bell dropdown.
app.get("/api/notifications", async c => {
  const limit = Number(c.req.query("limit") ?? "12")
  const { harness } = await getAgents(c.env)
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
  const { jobAgent } = await getAgents(c.env)
  try {
    return c.json(await jobAgent.getJob(jobId))
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// =============================================================================
// Research
// =============================================================================

app.get("/api/research", async c => {
  const { researchAgent } = await getAgents(c.env)
  try {
    const [topics, findings] = await Promise.all([
      researchAgent.getTopics(),
      researchAgent.getRecentFindings(20),
    ])
    return c.json({ topics, findings })
  } catch (e: any) {
    console.error("[/api/research] THREW:", e?.stack ?? e)
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.post("/api/research/run", async c => {
  const body = await c.req.json()
  const { researchAgent } = await getAgents(c.env)
  return c.json(
    await researchAgent.research({
      topic: body.topic,
      depth: body.depth ?? "standard",
    }),
  )
})

// =============================================================================
// Job Pipeline
// =============================================================================

app.get("/api/pipeline", async c => {
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.getPipeline())
})

// =============================================================================
// Job sources — operator-configured job websites the agent is allowed to browse.
// CRUD routes backing the dashboard's "Sources" management UI. The agent's
// search tools read the same `job_sources` table at runtime to scope every
// fetch_page / search_site to an enabled source's origin.
// =============================================================================

app.get("/api/job-sources", async c => {
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.listJobSources())
})

app.post("/api/job-sources", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.addJobSource(body))
})

app.put("/api/job-sources/:id", async c => {
  const id = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
  return c.json({
    message: await jobAgent.updateJobSource(id, body),
  })
})

app.delete("/api/job-sources/:id", async c => {
  const id = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env)
  return c.json({ message: await jobAgent.removeJobSource(id) })
})

app.post("/api/jobs", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.addJob(body))
})

app.post("/api/jobs/:id/cover-letter", async c => {
  const jobId = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.generateCoverLetter({ jobId }))
})

app.get("/api/jobs/:id/cover-letters", async c => {
  const jobId = Number(c.req.param("id"))
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.getCoverLettersForJob(jobId))
})

app.put("/api/jobs/:id/status", async c => {
  const jobId = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
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
  const { jobAgent } = await getAgents(c.env)
  return c.json({ message: await jobAgent.deleteJob({ jobId }) })
})

app.post("/api/jobs/:id/follow-up", async c => {
  const jobId = Number(c.req.param("id"))
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
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
  const { jobAgent } = await getAgents(c.env)
  return c.json(await jobAgent.getProfile())
})

app.put("/api/profile", async c => {
  const body = await c.req.json()
  const { jobAgent } = await getAgents(c.env)
  return c.json({ message: await jobAgent.setProfile(body) })
})

// CV file upload — stores the uploaded bytes as profile.cv. Text formats
// (.txt/.md) are normally handled client-side (populated into the textarea
// without a round-trip), but binary formats (PDF/DOCX) need a server round-
// trip because they can't be edited inline. We store the bytes as a base64
// data URL so the getProfile() consumer can see the format and size, and the
// cover-letter writer can pass them on to the LLM.
app.post("/api/profile/cv", async c => {
  const { jobAgent } = await getAgents(c.env)
  const filename = c.req.query("filename") || "cv"
  const contentType = c.req.header("Content-Type") || "application/octet-stream"
  const raw = await c.req.arrayBuffer()
  // Cap at 2 MB — CVs are small; prevent abuse.
  if (raw.byteLength > 2 * 1024 * 1024) {
    return c.json({ error: "File too large (max 2 MB)" }, 413)
  }
  const base64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
  const dataUrl = `data:${contentType};filename=${encodeURIComponent(
    filename,
  )};base64,${base64}`
  await jobAgent.setProfile({ cv: dataUrl })
  return c.json({
    message: `CV uploaded (${filename}, ${raw.byteLength} bytes)`,
    cv: dataUrl,
  })
})

// =============================================================================
// Follow-ups
// =============================================================================

app.get("/api/follow-ups", async c => {
  const { jobAgent } = await getAgents(c.env)
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

  // Cron watchdog — thin forwarder.
  //
  // Previously this was a 3-RPC decision sequence (getStatus →
  // checkSchedulesDue → start) with the Worker acting as the brain. That made
  // the harness reactive to Worker-side decisions and was racy. Now the Worker
  // just forwards the wake signal; the harness inspects its own state and
  // decides internally whether a run is due. This is the Managed Agents
  // "wake(sessionId)" shape: events flow in, the brain takes over.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const harness = await getAgentByName<Env, Harness>(
        env.HARNESS,
        HARNESS_ID,
      )
      const result = await harness.wake()
      if (result.ran) {
        console.log(`[watchdog] harness wake → ${result.reason}`)
      }
    } catch (error: any) {
      console.error("[watchdog] wake() error:", error.message)
    }
  },
}

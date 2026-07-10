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
import { renderDashboard } from "./views/renderDashboard"
import { getAgents, HARNESS_ID } from "./utils/get-agents"

// Re-export all Durable Object classes (required by Cloudflare)
export { Harness, ResearchAgent, JobApplicationAgent } from "./agents"
// =============================================================================
// Hono app
// =============================================================================

const app = new Hono<{ Bindings: Env }>()

// JSX renderer middleware: wraps c.render(...) calls in <Layout>.
app.use("/", renderer)

// CORS on every route (preflight handled automatically by the middleware).
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

// Bearer-token auth on everything under /api/*.
// The dashboard HTML at "/" stays public (it prompts for the token client-side).
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
// Dashboard (public) — rendered through Hono's jsxRenderer → <Layout><Dashboard/></Layout>.
// Assets (CSS/JS) are linked from the [assets] binding, not inlined.
// =============================================================================

app.get("/", c => renderDashboard(c))

// =============================================================================
// Status & Control
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
  return c.json(await harness.listSchedules())
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
  return c.json({ message: await harness.setMemory(body.key, String(body.value ?? "")) })
})

app.delete("/api/memory/:key", async c => {
  const key = decodeURIComponent(c.req.param("key"))
  const { harness } = await getAgents(c.env)
  return c.json({ message: await harness.forgetMemory(key) })
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

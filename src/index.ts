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
import { Harness } from "./harness"
import { ResearchAgent } from "./research-agent"
import { JobApplicationAgent } from "./job-agent"
// Hono JSX rendering: the renderer (in Layout.tsx) wraps c.render(...) in
// <Layout>, and renderDashboard (a .tsx helper) renders <Dashboard/>. index.ts
// itself stays JSX-free since it's a .ts file.
import { renderer } from "./views/Layout"
import { renderDashboard } from "./views/renderDashboard"

// Re-export all Durable Object classes (required by Cloudflare)
export { Harness } from "./harness"
export { ResearchAgent } from "./research-agent"
export { JobApplicationAgent } from "./job-agent"

// =============================================================================
// Hono app
// =============================================================================

const HARNESS_ID = "main" // single long-running harness instance

const app = new Hono<{ Bindings: Env }>()

// JSX renderer middleware: wraps c.render(...) calls in <Layout>.
// NOTE: scoped to the dashboard route only. Mounting it on "*" previously
// applied the renderer to /api/* JSON routes, which broke them with
// "Cannot read properties of undefined (reading 'onError')" because the
// renderer middleware assumes a render context that JSON handlers never set up.
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
app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header("Authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (!token || token !== c.env.DASHBOARD_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  await next()
})

// -----------------------------------------------------------------------------
// Helper: typed agent stubs for this request
// -----------------------------------------------------------------------------

async function getAgents(env: Env) {
  const harness = await getAgentByName<Env, Harness>(env.HARNESS, HARNESS_ID)
  const jobAgent = await getAgentByName<Env, JobApplicationAgent>(
    env.JOB_AGENT,
    HARNESS_ID,
  )
  const researchAgent = await getAgentByName<Env, ResearchAgent>(
    env.RESEARCH_AGENT,
    HARNESS_ID,
  )
  return { harness, jobAgent, researchAgent }
}

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

  // Cron watchdog — self-heals the Harness
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const harness = await getAgentByName<Env, Harness>(
        env.HARNESS,
        HARNESS_ID,
      )
      const status = await harness.getStatus()

      if (status === "idle" || status === "error") {
        const isDue = await harness.checkSchedulesDue()
        if (isDue) {
          console.log(
            `[watchdog] Starting harness run (previous status: ${status})`,
          )
          await harness.start()
        }
      }
    } catch (error: any) {
      console.error("[watchdog] Error:", error.message)
    }
  },
}

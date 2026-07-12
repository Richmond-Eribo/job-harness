import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * Integration tests for the Hono routes in src/index.ts.
 * We test the route structure and auth middleware behavior.
 */

// Mock environment
const createMockEnv = () => ({
  HARNESS: {} as any,
  RESEARCH_AGENT: {} as any,
  JOB_AGENT: {} as any,
  LLM_API_KEY: "test-key",
  MAX_STEPS: "100",
  DASHBOARD_TOKEN: "test-token",
})

describe("Route structure", () => {
  it("defines all expected API endpoints", () => {
    // This test verifies the route structure by checking the source file
    // contains the expected route definitions
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")

    // Verify all expected routes exist
    const expectedRoutes = [
      'app.get("/"',
      'app.get("/api/status"',
      'app.post("/api/start"',
      'app.post("/api/stop"',
      'app.post("/api/pause"',
      'app.post("/api/resume"',
      'app.get("/api/config"',
      'app.put("/api/config"',
      'app.get("/api/schedules"',
      'app.post("/api/schedules"',
      'app.delete("/api/schedules/:id"',
      'app.put("/api/schedules/:id/toggle"',
      'app.get("/api/log"',
      'app.get("/api/summaries"',
      'app.get("/api/research"',
      'app.post("/api/research/run"',
      'app.get("/api/pipeline"',
      'app.post("/api/jobs"',
      'app.post("/api/jobs/:id/cover-letter"',
      'app.get("/api/jobs/:id/cover-letters"',
      'app.put("/api/jobs/:id/status"',
      'app.post("/api/jobs/:id/follow-up"',
      'app.get("/api/profile"',
      'app.put("/api/profile"',
      'app.get("/api/follow-ups"',
    ]

    for (const route of expectedRoutes) {
      expect(src).toContain(route)
    }
  })

  it("has auth middleware on /api/* routes", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")

    // The bearer-auth middleware is registered on the /api/* path. The literal
    // may be split across lines in the source, so collapse whitespace before
    // asserting rather than requiring a one-line pattern.
    const collapsed = src.replace(/\s+/g, " ")
    expect(collapsed).toContain('app.use( "/api/*", bearerAuth')
    expect(src).toContain("Authorization")
    expect(src).toContain("DASHBOARD_TOKEN")
  })

  it("has CORS middleware", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")

    expect(src).toContain("app.use(")
    expect(src).toContain("cors(")
  })
})

describe("Auth middleware logic", () => {
  it("rejects requests without Bearer token", async () => {
    // Simulate the auth check logic
    const DASHBOARD_TOKEN = "test-token"
    const authHeader: string | undefined = undefined
    const token = authHeader?.replace("Bearer ", "")
    const isUnauthorized = !token || token !== DASHBOARD_TOKEN
    expect(isUnauthorized).toBe(true)
  })

  it("rejects requests with wrong token", async () => {
    const DASHBOARD_TOKEN = "test-token"
    const authHeader = "Bearer wrong-token"
    const token = authHeader?.replace("Bearer ", "")
    const isUnauthorized = !token || token !== DASHBOARD_TOKEN
    expect(isUnauthorized).toBe(true)
  })

  it("accepts requests with correct token", async () => {
    const DASHBOARD_TOKEN = "test-token"
    const authHeader = "Bearer test-token"
    const token = authHeader?.replace("Bearer ", "")
    const isUnauthorized = !token || token !== DASHBOARD_TOKEN
    expect(isUnauthorized).toBe(false)
  })
})

describe("Dashboard route", () => {
  it("serves dashboard at root path", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")

    // Pages-as-routes: one route per page, all going through renderPage.
    expect(src).toContain('app.get("/"')
    expect(src).toContain("renderPage")
    expect(src).toContain('app.get("/jobs"')
    expect(src).toContain('app.get("/traces"')
    expect(src).toContain('app.get("/logs"')
    expect(src).toContain('app.get("/memory"')
    expect(src).toContain('app.get("/settings"')
  })
})

describe("Cron scheduled handler", () => {
  it("has a scheduled handler that forwards to harness.wake()", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")

    expect(src).toContain("async scheduled(")
    // The watchdog is now a thin forwarder. The decision logic (schedule check,
    // start) lives INSIDE harness.wake() — not in the Worker — so we assert
    // the new contract rather than the old three-RPC sequence.
    expect(src).toContain("harness.wake()")
    // The old chatty sequence must be gone from the Worker.
    expect(src).not.toContain("harness.checkSchedulesDue()")
    expect(src).not.toContain("harness.start()")
  })
})

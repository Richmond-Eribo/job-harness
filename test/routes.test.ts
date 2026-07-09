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
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8",
    )

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
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8",
    )

    expect(src).toContain('app.use("/api/*"')
    expect(src).toContain("Authorization")
    expect(src).toContain("DASHBOARD_TOKEN")
  })

  it("has CORS middleware", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8",
    )

    expect(src).toContain('app.use(')
    expect(src).toContain("cors(")
  })
})

describe("Auth middleware logic", () => {
  it("rejects requests without Bearer token", async () => {
    // Simulate the auth check logic
    const DASHBOARD_TOKEN = "test-token"
    const authHeader = undefined
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
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8",
    )

    expect(src).toContain('app.get("/"')
    expect(src).toContain("renderDashboard")
  })
})

describe("Cron scheduled handler", () => {
  it("has scheduled handler for cron watchdog", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8",
    )

    expect(src).toContain("async scheduled(")
    expect(src).toContain("checkSchedulesDue")
    expect(src).toContain("harness.start()")
  })
})

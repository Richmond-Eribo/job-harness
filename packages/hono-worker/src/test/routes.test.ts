import { describe, it, expect } from "vitest"

/**
 * Integration tests for the Hono routes in src/index.ts.
 *
 * After the pure-REST cutover (TS-3), this worker serves NO HTML — the UI is a
 * separate TanStack Start app. These tests verify the route surface is REST +
 * WS + auth only, and that the HTML handlers + their imports are gone.
 */

function readSrc(): string {
  const fs = require("fs")
  const path = require("path")
  return fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf-8")
}

describe("Route structure", () => {
  it("defines all expected API endpoints", () => {
    const src = readSrc()
    const expectedRoutes = [
      'app.get("/api/status"',
      'app.post("/api/start"',
      'app.get("/api/start/preflight"',
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
      'app.get("/api/pipeline"',
      'app.post("/api/jobs"',
      'app.post("/api/jobs/:id/cover-letter"',
      'app.get("/api/jobs/:id/cover-letters"',
      'app.put("/api/jobs/:id/status"',
      'app.post("/api/jobs/:id/follow-up"',
      'app.get("/api/profile"',
      'app.put("/api/profile"',
      'app.get("/api/follow-ups"',
      'app.get("/healthz"',
      'app.post("/api/browser/pair"',
      'app.post("/api/browser/pair/redeem"',
      'app.post("/api/browser/refresh"',
      'app.post("/api/browser/unpair"',
      'app.get("/api/account/export"',
      'app.delete("/api/account"',
    ]
    for (const route of expectedRoutes) {
      expect(src).toContain(route)
    }
  })

  it("gates /api/debug/* behind IS_LOCAL_DEV", () => {
    const src = readSrc()
    expect(src).toContain('app.use("/api/debug/*"')
    expect(src).toContain("IS_LOCAL_DEV")
  })

  it("exempts extension pair/redeem + refresh from session auth", () => {
    const fs = require("fs")
    const path = require("path")
    const requireAuthSrc = fs.readFileSync(
      path.join(__dirname, "..", "auth", "require-auth.ts"),
      "utf-8",
    )
    expect(requireAuthSrc).toContain("/api/browser/pair/redeem")
    expect(requireAuthSrc).toContain("/api/browser/refresh")
  })

  it("has session-cookie auth on all routes", () => {
    const src = readSrc()
    // requireAuth runs on "*" and gates the /api/* routes. Better Auth's own
    // endpoints are mounted before the gate.
    expect(src).toContain('app.use("*", requireAuth)')
    expect(src).toContain("requireAuth")
    expect(src).toContain("/api/auth/")
    expect(src).toContain("getAuth(c)")
  })

  it("has CORS middleware with credentials", () => {
    const src = readSrc()
    // Cross-origin SPA needs credentials:true (can't use origin:"*").
    expect(src).toContain("cors(")
    expect(src).toContain("credentials: true")
  })
})

describe("Pure-REST cutover (no HTML)", () => {
  it("does NOT serve any HTML pages or the SPA shell", () => {
    const src = readSrc()
    // The HTML handlers were removed in TS-3. If any of these reappear it means
    // someone re-introduced server-rendered UI, which contradicts the
    // standalone-frontend architecture.
    expect(src).not.toContain('app.get("/",')
    expect(src).not.toContain('app.get("/legacy"')
    expect(src).not.toContain('app.get("/jobs"')
    expect(src).not.toContain('app.get("/traces"')
    expect(src).not.toContain('app.get("/logs"')
    expect(src).not.toContain('app.get("/memory"')
    expect(src).not.toContain('app.get("/settings"')
    expect(src).not.toContain('app.get("/login"')
    expect(src).not.toContain('app.get("/onboarding"')
    expect(src).not.toContain('app.get("/app"')
  })

  it("does NOT import the SSR page components or renderer", () => {
    const src = readSrc()
    // The views/ SSR imports are dead after the cutover.
    expect(src).not.toContain('from "./views/Layout"')
    expect(src).not.toContain('from "./views/renderDashboard"')
    expect(src).not.toContain('from "./views/pages/')
    expect(src).not.toContain("renderPage")
  })

  it("does NOT reference the ASSETS binding", () => {
    const src = readSrc()
    // No static-file serving — the frontend is a separate deploy.
    expect(src).not.toContain("c.env.ASSETS")
    expect(src).not.toContain("env.ASSETS")
  })
})

describe("Auth middleware logic", () => {
  it("rejects requests without a session (401 JSON, no HTML redirect)", () => {
    // requireAuth lives in src/auth/require-auth.ts. After the pure-REST cutover
    // there are no HTML redirects — the frontend handles routing on 401/428.
    const fs = require("fs")
    const path = require("path")
    const authSrc = fs.readFileSync(
      path.join(__dirname, "..", "auth", "require-auth.ts"),
      "utf-8",
    )
    expect(authSrc).toContain("{ error: \"Unauthorized\" }, 401")
    expect(authSrc).toContain("{ error: \"Onboarding required\" }, 428")
    // No HTML redirects remain.
    expect(authSrc).not.toContain('c.redirect("/login")')
    expect(authSrc).not.toContain('c.redirect("/onboarding")')
  })
})

describe("Cron scheduled handler", () => {
  it("has a scheduled handler that forwards to harness.wake()", () => {
    const src = readSrc()
    expect(src).toContain("async scheduled(")
    // The watchdog is a thin forwarder. The decision logic (schedule check,
    // start) lives INSIDE harness.wake() — not in the Worker.
    expect(src).toContain("harness.wake()")
    // The old chatty sequence must be gone from the Worker.
    expect(src).not.toContain("harness.checkSchedulesDue()")
    expect(src).not.toContain("harness.start()")
  })
})

// =============================================================================
// Security hardening (audit remediation) — structural guarantees.
// =============================================================================
// The behavioral tests for the validation helpers + origin-check middleware
// live in src/test/validation.test.ts; these assert the worker WIRING stays
// in place (nobody reintroduces the fallback router or drops the middleware).
// =============================================================================
describe("Security hardening wiring", () => {
  it("does NOT route unmatched requests to the agents-SDK DO router (audit C1)", () => {
    const src = readSrc()
    // The fallback forwarded /agents/{ns}/{name} — including WS upgrades —
    // straight to idFromName(name) with no auth callback, letting any
    // authenticated user reach any other user's Durable Objects.
    expect(src).not.toContain("import { routeAgentRequest")
    expect(src).not.toContain("await routeAgentRequest(")
  })

  it("mounts secure headers + the origin-check middleware (audit H3/M8)", () => {
    const src = readSrc()
    expect(src).toContain("secureHeaders()")
    expect(src).toContain('app.use("*", originCheck)')
    // Origin check must sit AFTER the cors middleware (preflight is answered
    // by cors and must never be blocked) — assert declaration order.
    expect(src.indexOf("cors(")).toBeLessThan(src.indexOf("app.use(\"*\", originCheck)"))
  })

  it("config route is key-allowlisted (audit C2)", () => {
    const src = readSrc()
    expect(src).toContain("CONFIG_ALLOWED_KEYS")
    expect(src).toContain("readJsonBody")
  })

  it("gates the E2E OTP bypass behind IS_LOCAL_DEV (audit M1)", () => {
    const fs = require("fs")
    const path = require("path")
    const authSrc = fs.readFileSync(
      path.join(__dirname, "..", "auth", "auth.ts"),
      "utf-8",
    )
    expect(authSrc).toContain(
      'env.E2E_OTP_BYPASS === "1" && isLocalDev',
    )
  })

  it("requires server-side confirmation for account deletion (audit M9)", () => {
    const fs = require("fs")
    const path = require("path")
    const accountSrc = fs.readFileSync(
      path.join(__dirname, "..", "auth", "account-routes.ts"),
      "utf-8",
    )
    expect(accountSrc).toContain("isAccountDeleteConfirmed")
  })
})

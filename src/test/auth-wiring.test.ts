import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import rateLimitsConfig from "../config/rate-limits.json"

/**
 * Tests for the auth wiring + rate-limit config.
 *
 * These are structural/config tests (the same pattern used by routes.test.ts)
 * because the full Better Auth + D1 stack needs the Workers runtime to
 * integration-test end-to-end. They verify:
 *   1. The magic-link endpoint is mounted at the correct path.
 *   2. The auth handler logs 5xx errors (not silent).
 *   3. The sendMagicLink callback has a try/catch (no raw throw → 500).
 *   4. The legacy login form posts to the correct Better Auth path.
 *   5. The rate-limits.json is well-formed and the rate-limiter reads it.
 */

const src = readFileSync(join(__dirname, "..", "index.ts"), "utf-8")
const authSrc = readFileSync(join(__dirname, "..", "auth", "auth.ts"), "utf-8")
const rateLimiterSrc = readFileSync(
  join(__dirname, "..", "agents", "rate-limiter.ts"),
  "utf-8",
)
const resendSrc = readFileSync(join(__dirname, "..", "auth", "resend.ts"), "utf-8")

describe("Better Auth mounting", () => {
  it("mounts the auth handler on /api/auth/*", () => {
    expect(src).toContain('"/api/auth/*"')
    expect(src).toContain("auth.handler(c.req.raw)")
  })

  it("logs 5xx responses from the auth handler", () => {
    // Regression: Better Auth's internal router swallows errors into empty
    // 500s. The handler MUST log on >= 500 so issues are diagnosable.
    expect(src).toMatch(/res\.status\s*>=\s*500/)
    expect(src).toContain("console.error")
  })
})

describe("Magic-link endpoint paths", () => {
  it("the frontend uses signInMagicLink (not the wrong sendMagicLinkEmail)", () => {
    const loginSrc = readFileSync(
      join(__dirname, "..", "..", "frontend", "src", "routes", "LoginPage.tsx"),
      "utf-8",
    )
    // The correct Better Auth client helper must be called.
    expect(loginSrc).toContain(".signInMagicLink(")
    // The wrong method that produced the 404 must NOT be CALLED (a comment
    // mentioning it is fine — we check for the call syntax, not the word).
    expect(loginSrc).not.toMatch(/\.magicLink\.sendMagicLinkEmail\s*\(/)
  })

  it("the legacy inline login form posts to /api/auth/sign-in/magic-link", () => {
    expect(src).toContain("/api/auth/sign-in/magic-link")
    // The old wrong path must not be present.
    expect(src).not.toContain("/api/auth/magic-link/sign-in")
  })
})

describe("sendMagicLink error handling", () => {
  it("wraps the Resend call in a try/catch (no raw throw → 500)", () => {
    // Regression: without try/catch, a Resend failure (unverified domain, bad
    // key) would crash the magic-link request into an empty 500.
    expect(authSrc).toMatch(/try\s*{[\s\S]*sendMagicLinkEmail[\s\S]*}\s*catch/)
  })
})

describe("Resend dev-fallback diagnostics", () => {
  it("names the specific missing value (not a generic message)", () => {
    // Regression: the old message was generic "no RESEND_API_KEY / MAIL_FROM".
    // It should now say which one is missing so misconfiguration is obvious.
    expect(resendSrc).toContain("RESEND_API_KEY")
    expect(resendSrc).toContain("MAIL_FROM")
    expect(resendSrc).toMatch(/missing/)
  })
})

describe("Rate limits config", () => {
  it("has the expected shape in rate-limits.json", () => {
    expect(rateLimitsConfig).toHaveProperty("llm")
    expect(rateLimitsConfig).toHaveProperty("activeRun")
    expect(rateLimitsConfig.llm).toHaveProperty("windowSeconds")
    expect(rateLimitsConfig.llm).toHaveProperty("max")
    expect(rateLimitsConfig.activeRun).toHaveProperty("windowSeconds")
    expect(rateLimitsConfig.activeRun).toHaveProperty("max")
  })

  it("the rate-limiter reads from the config file (not hardcoded)", () => {
    // Regression: the limits were hardcoded as { window: 60, max: 30 }.
    // Now they're driven by src/config/rate-limits.json.
    expect(rateLimiterSrc).toContain("rate-limits.json")
    expect(rateLimiterSrc).toContain("LLM_RATE_LIMIT")
    expect(rateLimiterSrc).toContain("ACTIVE_RUN_LIMIT")
  })

  it("exports the limits with a `window` + `max` shape (for the harness)", () => {
    // The harness reads LLM_RATE_LIMIT.window + .max — verify the shape.
    expect(rateLimiterSrc).toMatch(/window:\s*cfg\.llm\?\.windowSeconds/)
    expect(rateLimiterSrc).toMatch(/max:\s*cfg\.llm\?\.max/)
  })
})

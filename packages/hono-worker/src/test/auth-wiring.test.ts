import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import rateLimitsConfig from "../config/rate-limits.json"

/**
 * Tests for the auth wiring + rate-limit config.
 *
 * These are structural/config tests (the same pattern used by routes.test.ts)
 * because the full Better Auth + D1 stack needs the Workers runtime to
 * integration-test end-to-end. They verify the email/password + email-OTP
 * wiring is in place:
 *   1. The auth handler is mounted on /api/auth/* and logs 5xx.
 *   2. emailAndPassword is enabled + requires email verification.
 *   3. The emailOTP plugin is wired (sendVerificationOTP → sendOtpEmail) with
 *      hashed storage, 6-digit codes, and an explicit frontend send after
 *      signup (NOT send-on-signup — see the test for why).
 *   4. The rate-limits.json is well-formed and the rate-limiter reads it.
 */

const src = readFileSync(join(__dirname, "..", "index.ts"), "utf-8")
const authSrc = readFileSync(join(__dirname, "..", "auth", "auth.ts"), "utf-8")
const rateLimiterSrc = readFileSync(
  join(__dirname, "..", "agents", "rate-limiter.ts"),
  "utf-8",
)
const resendSrc = readFileSync(join(__dirname, "..", "auth", "resend.ts"), "utf-8")
const signupSrc = readFileSync(
  join(__dirname, "..", "..", "..", "frontend", "src", "pages", "SignupPage.tsx"),
  "utf-8",
)

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

describe("Email/password + OTP wiring", () => {
  it("enables email/password with email verification required", () => {
    expect(authSrc).toMatch(/emailAndPassword:\s*\{/)
    expect(authSrc).toContain("enabled: true")
    expect(authSrc).toContain("requireEmailVerification: true")
  })

  it("uses the emailOTP plugin (not magic-link)", () => {
    expect(authSrc).toMatch(/import\s*\{[^}]*emailOTP[^}]*\}\s*from\s*["']better-auth\/plugins["']/)
    expect(authSrc).not.toContain("magicLink(")
  })

  it("wires sendVerificationOTP to sendOtpEmail with hashed storage + 6-digit codes", () => {
    expect(authSrc).toContain("sendVerificationOTP")
    expect(authSrc).toContain("sendOtpEmail")
    expect(authSrc).toContain('storeOTP: "hashed"')
    expect(authSrc).toMatch(/otpLength:\s*6/)
  })

  it("routes core verification through OTP (explicit send after signup)", () => {
    // sendVerificationOnSignUp is deliberately FALSE: Better Auth's
    // signUp.email short-circuits duplicate-email signups to a synthetic 200
    // (anti-enumeration) BEFORE the send path, so auto-send would strand
    // those users without a code. Instead the frontend explicitly calls
    // sendVerificationOtp right after signUp.email returns — which mints +
    // sends a fresh code on BOTH the new-user and duplicate paths.
    expect(authSrc).toContain("sendVerificationOnSignUp: false")
    expect(authSrc).toContain("overrideDefaultEmailVerification: true")
    expect(signupSrc).toMatch(/sendVerificationOtp/)
  })

  it("the frontend uses email/password sign-up (not magic-link)", () => {
    const signupSrc = readFileSync(
      join(__dirname, "..", "..", "..", "frontend", "src", "pages", "SignupPage.tsx"),
      "utf-8",
    )
    // The client helper for email/password sign-up. Cast-tolerant — the test
    // checks for the call, not the typing.
    expect(signupSrc).toMatch(/signUpEmail\s*\(/)
    expect(signupSrc).not.toContain(".signInMagicLink(")
  })
})

describe("Resend OTP delivery", () => {
  it("sendOtpEmail calls Resend with the code (no dev-mode console fallback)", () => {
    // The old sendMagicLinkEmail had a console-log dev fallback; sendOtpEmail
    // must NOT — it throws when the key/sender is missing, by design.
    expect(resendSrc).toContain("sendOtpEmail")
    expect(resendSrc).toMatch(/new Resend\(apiKey/)
    // It surfaces missing-config loudly rather than silently logging.
    expect(resendSrc).toMatch(/missing/)
    expect(resendSrc).toMatch(/throw new Error/)
    expect(resendSrc).not.toMatch(/console\.log.*dev mode/)
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

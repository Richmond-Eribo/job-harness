import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  signUpBodySchema,
  isWithinSendCooldown,
} from "../auth/auth"

/**
 * Tests for the server-driven signup OTP (the double-send fix).
 *
 * The full Better Auth + D1 + hooks pipeline needs the Workers runtime (see
 * vitest.workers.config.ts's KNOWN BLOCKER), so — following the auth-wiring
 * pattern — behavior is covered at two layers:
 *   1. HERE (node pool): the exported validation schema + cooldown predicate,
 *      plus structural assertions that the hooks are wired the way the fix
 *      requires.
 *   2. E2E (packages/e2e/tests/02-signup.spec.ts): the real flow, including
 *      the double-submit case.
 *
 * What the fix guarantees (and these tests pin down):
 *   - The SERVER mints + sends the code during signUp.email (hooks.after) —
 *     on both the fresh-user path AND the duplicate-email synthetic 200.
 *   - A code minted within OTP_SEND_COOLDOWN_MS suppresses further sends:
 *     the before-hook short-circuits the send endpoint with { success: true }.
 *   - The frontend's account step never calls sendVerificationOtp itself.
 */

const authSrc = readFileSync(join(__dirname, "..", "auth", "auth.ts"), "utf-8")
const signupSrc = readFileSync(
  join(__dirname, "..", "..", "..", "frontend", "src", "pages", "SignupPage.tsx"),
  "utf-8",
)

describe("signUpBodySchema (front-door zod gate)", () => {
  it("accepts a well-formed signup body and strips unknown keys", () => {
    const parsed = signUpBodySchema.safeParse({
      email: "user@example.com",
      password: "longenough1!",
      name: "First Last",
      callbackURL: "https://ignored.example.com", // stripped, not rejected
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        email: "user@example.com",
        password: "longenough1!",
        name: "First Last",
      })
    }
  })

  it("rejects a malformed email", () => {
    const parsed = signUpBodySchema.safeParse({
      email: "not-an-email",
      password: "longenough1!",
      name: "First Last",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a short password", () => {
    const parsed = signUpBodySchema.safeParse({
      email: "user@example.com",
      password: "short",
      name: "First Last",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an empty/blank name (SignupPage requires first+last)", () => {
    for (const name of ["", "   "]) {
      const parsed = signUpBodySchema.safeParse({
        email: "user@example.com",
        password: "longenough1!",
        name,
      })
      expect(parsed.success).toBe(false)
    }
  })
})

describe("isWithinSendCooldown (resend suppression)", () => {
  it("is true for a row created seconds ago (ISO string — the D1 shape)", () => {
    expect(isWithinSendCooldown(new Date(Date.now() - 5_000).toISOString())).toBe(
      true,
    )
  })

  it("is true for a row created seconds ago (Date instance)", () => {
    expect(isWithinSendCooldown(new Date(Date.now() - 5_000))).toBe(true)
  })

  it("is false once the 30s window has passed", () => {
    expect(
      isWithinSendCooldown(new Date(Date.now() - 31_000).toISOString()),
    ).toBe(false)
  })

  it("fails open on garbage/missing createdAt (never swallow a first code)", () => {
    expect(isWithinSendCooldown(undefined)).toBe(false)
    expect(isWithinSendCooldown(null)).toBe(false)
    expect(isWithinSendCooldown("not-a-date")).toBe(false)
    expect(isWithinSendCooldown(12345)).toBe(false)
  })
})

describe("server-driven send wiring (structural)", () => {
  it("registers top-level before/after hooks via createAuthMiddleware", () => {
    expect(authSrc).toMatch(/hooks:\s*\{/)
    expect(authSrc).toMatch(/before:\s*createAuthMiddleware/)
    expect(authSrc).toMatch(/after:\s*createAuthMiddleware/)
  })

  it("the after-hook triggers the send for signUp.email results", () => {
    // Fires on BOTH outcomes — the email comes off the endpoint response,
    // which carries the requested address on the synthetic duplicate path
    // too (that's the regression the old client-side send worked around).
    expect(authSrc).toContain('const SIGNUP_PATH = "/sign-up/email"')
    expect(authSrc).toContain("emailFromSignUpResult(ctx.context.returned)")
    expect(authSrc).toMatch(/sendVerificationOtp\(\{\s*email,/)
  })

  it("the before-hook gates the send endpoint on the cooldown", () => {
    // The latest verification row for the email-verification identifier must
    // be checked, and a fresh row short-circuits with the endpoint's success
    // shape so callers can't distinguish a suppressed send from a real one.
    expect(authSrc).toContain(
      'const SEND_OTP_PATH = "/email-otp/send-verification-otp"',
    )
    expect(authSrc).toMatch(/findVerificationValue\(/)
    expect(authSrc).toMatch(/isWithinSendCooldown\(latest\.createdAt\)/)
    expect(authSrc).toContain("return { success: true }")
    expect(authSrc).toContain("email-verification-otp-")
  })

  it("the plugin's own auto-send stays off (no double from the plugin)", () => {
    expect(authSrc).toContain("sendVerificationOnSignUp: false")
  })

  it("the frontend's account step no longer sends the OTP itself", () => {
    // Slice the source between the step markers; the account action must not
    // CALL the send endpoint (comments may mention it by name). The verify
    // step's Resend button legitimately still calls it — cooldown-protected
    // server-side now.
    const start = signupSrc.indexOf("Step 1: create account")
    const end = signupSrc.indexOf("Step 2: verify the OTP")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const accountStep = signupSrc.slice(start, end)
    expect(accountStep).not.toMatch(/authClient\.emailOtp\.sendVerificationOtp/)
  })
})

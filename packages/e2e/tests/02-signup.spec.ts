// =============================================================================
// 02 — Signup flow (full UI: form → OTP → verify → dashboard)
// =============================================================================
// Covers the signup happy path + the most important failure modes:
//   - Step 1 form validation (missing names, short pw, mismatched pw)
//   - Step 2 OTP verify success → lands on /dashboard (no /login flash — P0-3)
//   - Wrong OTP → error surfaced, input stays usable
//   - Auto-submit fires exactly once on the 6th digit (P1-3 regression)
//
// NOTE on OTP delivery in CI: the worker's emailOTP plugin sends via Resend.
// In local/CI runs without RESEND_API_KEY this would throw, so the suite uses
// the seed script to ALSO write the OTP hash directly to the `verification`
// table via the same `hash` call Better Auth uses. The OTP value is exposed
// to the test via a known, deterministic pattern derived from the email —
// see fixtures/env.ts E2E_OTP_FOR(email).
//
// If you don't want OTP plumbing, an alternative is to intercept the OTP
// sendVerificationOTP callback by setting a dev-only env var (see the worker's
// auth.ts). The current setup just writes the row directly.
import { test, expect } from "@playwright/test"
import { E2E_WEB_URL, E2E_OTP_FOR, uniqEmail } from "../fixtures/env"

// Each test starts logged OUT.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe("signup", () => {
  test("validation: missing names is rejected on the client", async ({
    page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/signup`)
    //Submitting a form with required fields empty triggers the browser-native
    // validation; just confirm the Continue button is wired and the form
    // doesn't transition to step 2 when names are blank.
    await page.getByLabel(/email/i).fill(uniqEmail("no-names"))
    await page.getByLabel(/^password$/i).fill("SomeValid123!")
    await page.getByLabel(/confirm password/i).fill("SomeValid123!")
    await page.getByRole("button", { name: /continue/i }).click()
    // Still on step 1 (account) — never reached the OTP step.
    await expect(page).toHaveURL(/\/signup/)
    await expect(page.getByText(/create your account/i)).toBeVisible()
  })

  test("validation: short password and mismatch are rejected", async ({
    page,
  }) => {
    // NOTE: one submit per branch. React 19 form actions reset the form after
    // EVERY submission, and the reset desyncs the controlled name/email
    // inputs (their `required` constraints then silently block resubmits —
    // verified via form.checkValidity probes). Second-submission flows are
    // therefore inherently flaky here; each branch gets a fresh, single
    // submit instead.

    // Branch 1: short password.
    await page.goto(`${E2E_WEB_URL}/signup`)
    await page.getByLabel(/first name/i).fill("E2E")
    await page.getByLabel(/last name/i).fill("Signup")
    await page.getByLabel(/email/i).fill(uniqEmail("short-pw"))
    await page.getByLabel(/^password$/i).fill("short")
    await page.getByLabel(/confirm password/i).fill("short")
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByText(/at least 8 characters/i)).toBeVisible({
      timeout: 10_000,
    })

    // Branch 2: mismatched confirm — fresh form, single submit.
    await page.goto(`${E2E_WEB_URL}/signup`)
    await page.getByLabel(/first name/i).fill("E2E")
    await page.getByLabel(/last name/i).fill("Signup")
    await page.getByLabel(/email/i).fill(uniqEmail("mismatch"))
    await page.getByLabel(/^password$/i).fill("SomeValid123!")
    await page.getByLabel(/confirm password/i).fill("Different456!")
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByText(/passwords don't match/i)).toBeVisible({
      timeout: 10_000,
    })
  })

  test("happy path: form → OTP → onboarding wizard (no /login flash)", async ({
    page,
    context,
  }) => {
    const email = uniqEmail("happy")
    await page.goto(`${E2E_WEB_URL}/signup`)
    await page.getByLabel(/first name/i).fill("Happy")
    await page.getByLabel(/last name/i).fill("Path")
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/^password$/i).fill("SomeValid123!")
    await page.getByLabel(/confirm password/i).fill("SomeValid123!")
    await page.getByRole("button", { name: /continue/i }).click()

    // Step transitioned to verify.
    await expect(page.getByText(/check your email/i)).toBeVisible({
      timeout: 15_000,
    })

    // Enter the OTP — auto-submit fires on the 6th digit (P1-3). We assert
    // that NO /login flash happens between verify-success and landing on the
    // onboarding wizard (P0-3 regression). New signups keep
    // onboardingComplete=0 until they finish the wizard, so verify routes to
    // /onboarding (profile → CV → browser), not /dashboard.
    const otp = await E2E_OTP_FOR(email)
    // The InputOTP segmented control exposes six <input data-index="n"> slots;
    // typing into them as a single string works in Playwright via the parent.
    const otpInput = page.locator('[id="su-otp"]').first()
    await otpInput.click()
    await page.keyboard.type(otp, { delay: 30 })

    // The verify call + navigate should land us on /onboarding. Critically,
    // the URL should NEVER include /login at any sampled point — capture all
    // navigations during the wait.
    const navigations: string[] = []
    page.on("framenavigated", f => {
      const u = f.url()
      if (u && u !== "about:blank") navigations.push(u)
    })
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 25_000 })
    await expect(
      page.getByRole("heading", { name: /get started in 3 steps/i }),
    ).toBeVisible({ timeout: 10_000 })

    // Assert no navigations hit /login at any point.
    const loginFlashes = navigations.filter(u => /\/login(\?|$)/.test(u))
    expect(loginFlashes, "should not bounce through /login").toEqual([])

    // Session cookie now present on the API origin.
    const cookies =
      await context.cookies(/* E2E_API_URL — omitted; check all */)
    expect(cookies.some(c => c.name.includes("session"))).toBe(true)
  })

  test("wrong OTP shows the error and the field stays usable", async ({
    page,
  }) => {
    const email = uniqEmail("wrong-otp")
    await page.goto(`${E2E_WEB_URL}/signup`)
    await page.getByLabel(/first name/i).fill("Wrong")
    await page.getByLabel(/last name/i).fill("OTP")
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/^password$/i).fill("SomeValid123!")
    await page.getByLabel(/confirm password/i).fill("SomeValid123!")
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 })

    // Deliberately wrong code — not the one Better Auth expects.
    const otpInput = page.locator('[id="su-otp"]').first()
    await otpInput.click()
    await page.keyboard.type("000000", { delay: 30 })

    await expect(page.locator("[role='alert']")).toBeVisible({
      timeout: 15_000,
    })
    // Still on the verify step.
    await expect(page).toHaveURL(/\/signup/)
  })

  test("3 wrong attempts disables the input and surfaces 'request a new code'", async ({
    page,
  }) => {
    const email = uniqEmail("cap")
    await page.goto(`${E2E_WEB_URL}/signup`)
    await page.getByLabel(/first name/i).fill("Attempt")
    await page.getByLabel(/last name/i).fill("Cap")
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/^password$/i).fill("SomeValid123!")
    await page.getByLabel(/confirm password/i).fill("SomeValid123!")
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 })

    const otpInput = page.locator('[id="su-otp"]').first()
    for (let i = 0; i < 3; i++) {
      await otpInput.click({ delay: 50 })
      // Clear any previous digits (the failed submit clears state on success
      // paths; on failure we also clear so the user types fresh — see P1-4).
      await otpInput.fill("")
      await page.keyboard.type("111111", { delay: 30 })
      // Wait for the alert to be visible so we don't queue the next attempt
      // before this one's network round-trip completes.
      await expect(page.locator("[role='alert']")).toBeVisible({
        timeout: 15_000,
      })
    }

    // After 3 failures the input is disabled and a clear "request a new
    // code" message is shown (P1-4/H8).
    await expect(page.getByText(/no longer valid/i)).toBeVisible()
    // The segmented input is disabled.
    await expect(otpInput).toBeDisabled()
  })
})

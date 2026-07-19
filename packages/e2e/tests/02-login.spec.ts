// =============================================================================
// 02 — Login flow (real /login UI + Better Auth sign-in + session cookie)
// =============================================================================
// Drives the actual LoginPage form (React 19 form action) with the seeded
// User A, then verifies the session cookie is attached cross-origin by hitting
// a protected API endpoint that requires it.
import { test, expect } from "@playwright/test"
import { E2E_API_URL, E2E_WEB_URL, USER_A } from "../fixtures/env"

// Each test here starts logged OUT (no storageState).
test.use({ storageState: { cookies: [], origins: [] } })

test.describe("login", () => {
  test("successful login lands on /dashboard", async ({ page, context }) => {
    await page.goto(`${E2E_WEB_URL}/login`)

    // Fill the form (uncontrolled inputs read from FormData on submit).
    await page.getByLabel(/email/i).fill(USER_A.email)
    await page.getByLabel("Password", { exact: true }).fill(USER_A.password)

    await page.getByRole("button", { name: /sign in/i }).click()

    // The login action navigates to /dashboard; the route's beforeLoad guard
    // passes (User A is verified + onboarded).
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 })

    // A protected resource the dashboard fetches should now resolve (proves the
    // SameSite=None cookie is attached cross-origin).
    const statusRes = await page.request.get(`${E2E_API_URL}/api/status`)
    expect(statusRes.status(), "GET /api/status after login").toBe(200)

    // The cookie itself lives on the API origin and is never readable via
    // document.cookie on the frontend origin — but it IS in the browser jar.
    const cookies = await context.cookies(E2E_API_URL)
    expect(cookies.some((c) => c.name.includes("session"))).toBe(true)
  })

  test("wrong password shows an error and stays on /login", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/login`)
    await page.getByLabel(/email/i).fill(USER_A.email)
    await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-pw")
    await page.getByRole("button", { name: /sign in/i }).click()

    // Better Auth surfaces a credentials error → the form shows the Alert.
    await expect(page.locator("[role='alert']")).toBeVisible({ timeout: 15_000 })

    // We did NOT navigate away.
    await expect(page).toHaveURL(/\/login/)
  })

  test("signed-in user visiting /login bounces to /dashboard", async ({
    browser,
  }) => {
    // Use the storageState saved by globalSetup (already-authenticated session).
    const ctx = await browser.newContext({ storageState: ".auth/user-a.json" })
    const page = await ctx.newPage()
    try {
      await page.goto(`${E2E_WEB_URL}/login`)
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 })
    } finally {
      await ctx.close()
    }
  })
})

// =============================================================================
// 03 — Onboarding guard (the 428 path)
// =============================================================================
// The seeded "not-onboarded" user has onboardingComplete=0. Visiting any
// protected page should redirect to /onboarding. Completing the onboarding form
// should flip the flag and allow /dashboard.
//
// The redirect is exercised both client-side (route beforeLoad guard) and
// server-side (the API returns 428 to any non-exempt endpoint).
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL, E2E_API_URL, USER_NOT_ONBOARDED } from "../fixtures/env"

// This whole file uses the not-onboarded user's saved session.
test.use({ storageState: ".auth/user-not-onboarded.json" })

test.describe("onboarding guard", () => {
  test("protected page redirects to /onboarding", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/dashboard`)
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 20_000 })
    await expect(page.getByRole("button", { name: /complete setup/i })).toBeVisible()
  })

  test("non-exempt API endpoint returns 428 (Onboarding required)", async ({
    request,
  }) => {
    // The session cookie is in the storageState; attach it by reusing the
    // saved cookies in a request context.
    const res = await request.get(`${E2E_API_URL}/api/status`, {
      // request fixture inherits the test's storageState cookies automatically
      maxRedirects: 0,
    })
    expect(res.status()).toBe(428)
    const body = await res.json().catch(() => null)
    expect(body?.error).toMatch(/onboarding/i)
  })

  test("completing onboarding reaches /dashboard", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/onboarding`)

    // Fill required + a few optional fields. (fullName is required.)
    await page.getByLabel(/full name/i).fill("New Onboarded User")
    await page.getByLabel(/target roles/i).fill("Senior TypeScript Engineer")
    await page.getByLabel(/skills \(comma-separated\)/i).fill("TypeScript, React, Cloudflare")

    await page.getByRole("button", { name: /complete setup/i }).click()

    // On success the action navigates to /dashboard.
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 })

    // And the API now accepts (no more 428).
    const statusRes = await page.request.get(`${E2E_API_URL}/api/status`)
    expect(statusRes.status()).toBe(200)
  })
})

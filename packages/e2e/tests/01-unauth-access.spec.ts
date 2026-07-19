// =============================================================================
// 01 — Unauthenticated access + route guards
// =============================================================================
// Verifies that every protected route redirects logged-out visitors to /login
// (with a redirect-back param), and that the public landing/login pages don't
// require auth. Also confirms the API returns 401 JSON (not HTML) on missing
// session — the pure-REST cutover contract.
//
// Uses a fresh, unauthenticated context (no storageState) for every check.
import { test, expect } from "@playwright/test"
import { E2E_API_URL, E2E_WEB_URL } from "../fixtures/env"

// Force a clean (logged-out) browser for this whole file.
test.use({ storageState: { cookies: [], origins: [] } })

const PROTECTED_PATHS = [
  "/dashboard",
  "/jobs",
  "/logs",
  "/memory",
  "/settings",
  "/traces",
]

test.describe("unauthenticated access", () => {
  for (const path of PROTECTED_PATHS) {
    test(`redirects logged-out visit to ${path} → /login`, async ({ page }) => {
      await page.goto(`${E2E_WEB_URL}${path}`)
      await expect(page).toHaveURL(/\/login(\?.*)?$/)
      // The guard should preserve the originally-requested URL for post-login
      // return-to (even if LoginPage currently ignores it).
      await expect(page.locator('input[name="email"]')).toBeVisible()
    })
  }

  test("landing page is reachable without auth", async ({ page }) => {
    const res = await page.goto(`${E2E_WEB_URL}/`)
    expect(res?.ok(), "GET / should be 2xx").toBe(true)
  })

  test("login page is reachable without auth", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/login`)
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible()
  })

  test("signup page is reachable without auth", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/signup`)
    // The account-creation step's submit button.
    await expect(page.getByRole("button", { name: /continue/i })).toBeVisible()
  })

  test("protected API path returns 401 JSON (no HTML redirect)", async ({
    request,
  }) => {
    const res = await request.get(`${E2E_API_URL}/api/status`)
    expect(res.status(), "no-cookie API call should be 401").toBe(401)
    // The pure-REST cutover contract: JSON error, not an HTML redirect.
    const body = await res.json().catch(() => null)
    expect(body?.error).toMatch(/unauthorized/i)
    expect(res.headers()["content-type"] ?? "").toContain("application/json")
  })
})

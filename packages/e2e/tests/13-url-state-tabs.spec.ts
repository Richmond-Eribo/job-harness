// =============================================================================
// 13 — URL-state tabs (nuqs / useTabParam)
// =============================================================================
// The Settings tabs (and JobDetail tabs, TraceDetail filter) are URL state
// (?tab=… / ?filter=…) via nuqs behind the shared useTabParam hook. These
// tests pin the three behaviors users depend on:
//   1. Deep links land on the right tab (the ExtensionStatusPill and the
//      Overview preflight link to /settings?tab=browser).
//   2. Clicking a tab reflects in the URL (shareable/refresh-safe) and the
//      default view keeps the URL clean (nuqs clearOnDefault).
//   3. Browser back/forward moves between tabs.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL } from "../fixtures/env"

test.describe("settings tabs are URL state", () => {
  test("deep link ?tab=browser opens the Browser & Extension tab", async ({
    userAPage: page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/settings?tab=browser`)
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible()

    // The Browser tab renders the ConnectBrowserCard funnel (Playwright's
    // browser has no extension installed, so step 1 must be visible).
    // CardTitle renders a <div>, so match by text, not heading role.
    await expect(
      page.getByText("Install the extension", { exact: true }),
    ).toBeVisible({ timeout: 15_000 })
    // The probe card is Browser-tab-only — proves we're not on Profile.
    await expect(
      page.getByText("Browser test", { exact: true }),
    ).toBeVisible()
  })

  test("default visit shows Profile with a clean URL", async ({
    userAPage: page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible()

    // Profile tab content (the CV card), not the Browser funnel.
    await expect(
      page.getByRole("button", { name: /upload cv/i }),
    ).toBeVisible({ timeout: 15_000 })
    // Selecting the DEFAULT tab clears the param — the URL stays clean.
    await expect(page).not.toHaveURL(/tab=/)
  })

  test("clicking a tab reflects in the URL and survives reload", async ({
    userAPage: page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible()

    await page.getByRole("tab", { name: /account/i }).click()
    await expect(page).toHaveURL(/[\?&]tab=account/)

    // Refresh-safe: the tab selection survives a cold reload.
    await page.reload()
    await expect(
      page.getByText("Delete account", { exact: true }),
    ).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL(/[\?&]tab=account/)
  })

  test("browser back returns to the previous tab", async ({
    userAPage: page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible()

    await page.getByRole("tab", { name: /account/i }).click()
    await expect(page).toHaveURL(/[\?&]tab=account/)

    await page.goBack()
    // Back lands on the default (Profile) view — clean URL, CV card visible.
    await expect(page).not.toHaveURL(/tab=account/)
    await expect(
      page.getByRole("button", { name: /upload cv/i }),
    ).toBeVisible({ timeout: 15_000 })
  })
})

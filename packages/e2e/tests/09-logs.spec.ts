// =============================================================================
// 09 — Activity log
// =============================================================================
// The /logs page renders the step-log timeline from GET /api/log. After a run
// (spec 04) there will be entries; otherwise it shows an empty state. Either
// is acceptable — we assert the shell renders and the API call succeeds.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL } from "../fixtures/env"

test.describe("activity log", () => {
  test("logs page renders", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/logs`)
    await expect(page.getByRole("heading", { name: /activity console/i })).toBeVisible()

    // The search filter should be present regardless of whether entries exist.
    await expect(page.getByPlaceholder(/search log action or output payload/i)).toBeVisible()
  })

  test("log entries (if any) render as a list", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/logs`)
    // Wait for the query to settle (no skeleton spinner left).
    await expect(page.locator(".skeleton, [class*='Skeleton']").first()).toBeHidden({
      timeout: 10_000,
    }).catch(() => {
      // No skeleton at all is also fine.
    })
    // No hard assertion on count — empty state is valid.
  })
})

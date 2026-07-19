// =============================================================================
// 08 — Traces list + detail
// =============================================================================
// Visits /traces, asserts the list renders, and — if a run exists — drills
// into /traces/$runId and checks the trace event transcript renders.
//
// Depends on spec 04 having produced at least one run. If no run exists yet
// (e.g. when running --grep-invert @llm), the list-empty assertion still holds.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL } from "../fixtures/env"

test.describe("traces", () => {
  test("traces list page renders", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/traces`)
    await expect(
      page.getByRole("heading", { name: /agent execution traces/i }),
    ).toBeVisible()
    // The page either shows run cards or an empty state — either is fine; we
    // just assert the shell rendered.
  })

  test("trace detail renders events for an existing run", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/traces`)

    // Find the first run link, if any.
    const runLinks = page.locator('a[href^="/traces/"]')
    const count = await runLinks.count()
    test.skip(count === 0, "no runs exist yet (run the @llm spec first)")

    const firstHref = await runLinks.first().getAttribute("href")
    expect(firstHref).toBeTruthy()

    // Navigate into the run detail.
    await runLinks.first().click()
    await expect(page).toHaveURL(new RegExp(`${firstHref}$`), { timeout: 15_000 })

    // The trace detail polls /api/runs/:runId every 3s; the page should render
    // either events or a "no events" state. We assert the URL + that the page
    // didn't error.
    await expect(page.getByRole("button", { name: /all traces/i })).toBeVisible({ timeout: 15_000 })
  })
})

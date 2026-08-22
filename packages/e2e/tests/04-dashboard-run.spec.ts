// =============================================================================
// 04 — Dashboard agent run  [@llm]
// =============================================================================
// Starts a REAL agent run via the Overview page's "Start Agent Run" button,
// which fires POST /api/start and triggers the live LLM loop (GLM-5.2 via
// z.ai). Asserts the status transitions idle → running, and that a run card
// appears on /traces. Stops the run at the end.
//
// Tagged @llm so it can be filtered in/out:
//   npx playwright test --grep-invert @llm    # skip the slow/expensive one
//   npx playwright test --grep @llm           # only the LLM test
//
// This is the ONLY test that spends real tokens.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL } from "../fixtures/env"

test.describe("dashboard run [@llm]", () => {
  test("start → running → run appears in traces → stop", async ({ userAPage: page }) => {
    test.setTimeout(180_000) // real agent runs take a while

    await page.goto(`${E2E_WEB_URL}/dashboard`)
    await expect(
      page.getByRole("heading", { name: /pipeline overview/i }),
    ).toBeVisible()

    // Snapshot the current run list length so we can detect the new run.
    await page.goto(`${E2E_WEB_URL}/traces`)
    const initialRunCount = await page
      .locator('[data-run-id], article, a[href^="/traces/"]')
      .count()

    // Go back to dashboard and start.
    await page.goto(`${E2E_WEB_URL}/dashboard`)
    const startButton = page.getByRole("button", { name: /start agent run/i })
    await expect(startButton).toBeVisible()
    await startButton.click()

    // The pre-flight UI gate only blocks (and pops a modal with "Start
    // anyway") when job-sources is missing. If User A has zero configured
    // sources, click "Start anyway" to skip — this LLM-cost test cares about
    // the runtime path, not setup completeness. If the modal doesn't appear,
    // this is a silent no-op. (POST /api/start no longer gates server-side;
    // the modal is purely advisory + frontend.)
    const startAnyway = page.getByRole("button", { name: /start anyway/i })
    if (await startAnyway.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await startAnyway.click()
    }

    // The button should switch to the Stop variant while running. Give the
    // run-loop a generous window to spin up (it cold-starts the DO + LLM).
    await expect(page.getByRole("button", { name: /stop agent/i })).toBeVisible(
      {
        timeout: 60_000,
      },
    )

    // A run card should appear on /traces shortly after the loop logs its
    // first step. Poll up to ~90s.
    await page.goto(`${E2E_WEB_URL}/traces`)
    await expect
      .poll(
        async () => {
          const runs = page.locator('a[href^="/traces/"]')
          return await runs.count()
        },
        { timeout: 90_000, message: "a new run card should appear on /traces" },
      )
      .toBeGreaterThan(initialRunCount)

    // Stop the run so we don't leave the LLM burning tokens after the test.
    await page.goto(`${E2E_WEB_URL}/dashboard`)
    const stopButton = page.getByRole("button", { name: /stop agent/i })
    if (await stopButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await stopButton.click()
    }
  })
})

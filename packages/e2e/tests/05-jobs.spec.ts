// =============================================================================
// 05 — Jobs pipeline (kanban CRUD + detail view + drag & drop)
// =============================================================================
// Covers the overhauled Jobs surface end-to-end:
//   1. add → see in "Discovered" → open the detail route → advance via the
//      stage select → auto follow-up on first "applied" → complete it → delete
//   2. drag a card from Discovered to Draft (pointer DnD) and verify the API
// All job creation/cleanup goes through the authenticated API — the agent
// normally fills the pipeline, not the tests.
import { test, expect } from "./../fixtures/auth"
import { E2E_API_URL, E2E_WEB_URL } from "../fixtures/env"
import { loginAs } from "../fixtures/api"
import { USER_A } from "../fixtures/env"

test.describe("jobs pipeline", () => {
  test("add → board → detail → advance → auto follow-up → complete → delete", async ({ userAPage: page }) => {
    const title = `E2E Job ${Date.now()}`
    const company = `E2E Corp ${Date.now()}`

    const session = await loginAs(USER_A.email, USER_A.password)
    try {
      const createRes = await session.context.post(`${E2E_API_URL}/api/jobs`, {
        data: { title, company, url: `https://example.test/${Date.now()}` },
      })
      expect(createRes.ok(), "POST /api/jobs").toBe(true)
      const created = await createRes.json()
      const jobId = created.id
      expect(jobId, "new job should have an id").toBeTruthy()

      try {
        // ── Board: the new card lands in the Discovered column ──────────
        await page.goto(`${E2E_WEB_URL}/jobs`)
        await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible()

        const card = page.locator(`[data-testid="job-card"]:has-text("${title}")`).first()
        await expect(card).toBeVisible({ timeout: 20_000 })
        await expect(
          page.locator('[data-column="discovered"] [data-testid="job-card"]').filter({
            hasText: title,
          }),
        ).toHaveCount(1)

        // ── Detail route: clicking the card opens /jobs/:id ─────────────
        await card.locator("text=" + title).first().click()
        await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
        await expect(page.getByTestId("job-detail-title")).toHaveText(title)

        // ── Advance discovered → draft via the stage select ──────────────
        await page.getByTestId("job-status-select").click()
        await page.getByRole("option", { name: "Draft" }).click()
        await expect(page.getByText(/moved to draft/i)).toBeVisible({ timeout: 10_000 })

        // ── Draft → applied: the server auto-creates a follow-up ────────
        await page.getByTestId("job-status-select").click()
        await page.getByRole("option", { name: "Applied" }).click()
        await expect(page.getByText(/moved to applied/i)).toBeVisible({ timeout: 10_000 })

        await page.getByRole("tab", { name: /follow-ups/i }).click()
        await expect(page.getByTestId("follow-up-list")).toBeVisible({ timeout: 15_000 })
        await expect(
          page.getByTestId("follow-up-list").locator("text=Follow up on application"),
        ).toBeVisible({ timeout: 15_000 })

        // ── Complete the follow-up ──────────────────────────────────────
        await page.getByLabel("Mark as done").first().click()
        await expect(
          page.getByTestId("follow-up-list").locator("text=Follow up on application"),
        ).toBeHidden({ timeout: 15_000 })

        // ── Delete (confirm dialog) → back to the board ─────────────────
        await page.getByRole("button", { name: /remove/i }).click()
        await page.getByTestId("confirm-dialog-confirm").click()
        await expect(page).toHaveURL(new RegExp(`/jobs$`), { timeout: 15_000 })
        await expect(
          page.locator(`[data-testid="job-card"]:has-text("${title}")`),
        ).toHaveCount(0, { timeout: 20_000 })
      } finally {
        // Always clean up so re-runs don't accumulate jobs.
        await session.context.delete(`${E2E_API_URL}/api/jobs/${jobId}`)
      }
    } finally {
      await session.dispose()
    }
  })

  test("drag and drop moves a card between columns", async ({ userAPage: page }) => {
    const title = `E2E DnD ${Date.now()}`
    const company = `E2E DnD Corp ${Date.now()}`

    const session = await loginAs(USER_A.email, USER_A.password)
    try {
      const createRes = await session.context.post(`${E2E_API_URL}/api/jobs`, {
        data: { title, company, url: `https://example.test/${Date.now()}` },
      })
      expect(createRes.ok(), "POST /api/jobs").toBe(true)
      const jobId = (await createRes.json()).id

      try {
        await page.goto(`${E2E_WEB_URL}/jobs`)
        const card = page.locator(`[data-testid="job-card"]:has-text("${title}")`).first()
        await expect(card).toBeVisible({ timeout: 20_000 })

        const draftCol = page.locator('[data-column="draft"]')
        await expect(draftCol).toBeVisible()

        // Pointer-sensor drag: press on the card, move in steps (the sensor
        // activates after 6px), release over the Draft column.
        const src = await card.boundingBox()
        const dst = await draftCol.boundingBox()
        expect(src && dst).toBeTruthy()

        await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2)
        await page.mouse.down()
        await page.mouse.move(dst!.x + dst!.width / 2, dst!.y + Math.min(dst!.height / 2, 120), {
          steps: 15,
        })
        await page.mouse.up()

        // The optimistic cache move is immediate; the API write follows.
        await expect
          .poll(
            async () => {
              const res = await session.context.get(`${E2E_API_URL}/api/jobs/${jobId}`)
              const detail = await res.json()
              return detail.listing?.status
            },
            { timeout: 20_000 },
          )
          .toBe("draft")
      } finally {
        await session.context.delete(`${E2E_API_URL}/api/jobs/${jobId}`)
      }
    } finally {
      await session.dispose()
    }
  })
})

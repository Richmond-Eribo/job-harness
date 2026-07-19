// =============================================================================
// 06 — Memory bank (user-memory CRUD)
// =============================================================================
// Adds a user-memory entry via the MemoryPage form (key/value), asserts it
// appears under "Your Defined Memories", and that the agent-memory section
// renders (empty state is acceptable). The entry persists in the user's Harness DO.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL } from "../fixtures/env"

test.describe("memory", () => {
  test("add a memory entry → it appears in the list", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/memory`)
    await expect(page.getByRole("heading", { name: /agent memory bank/i })).toBeVisible()

    const key = `e2e_key_${Date.now()}`
    const value = `e2e value at ${new Date().toISOString()}`

    await page.getByLabel(/memory key/i).fill(key)
    await page.getByLabel(/memory value/i).fill(value)

    const save = page.getByRole("button", { name: /save memory entry/i })
    await save.click()

    // Toast on success.
    await expect(page.getByText(/memory entry saved/i)).toBeVisible({ timeout: 10_000 })

    // The new entry card should appear under "Your Defined Memories". Match by
    // the key (rendered in a mono font in the card).
    await expect(page.locator("text=" + key).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("text=" + value).first()).toBeVisible()

    // The agent-memory section header is always rendered (even when empty).
    await expect(page.getByText(/agent learned memories/i)).toBeVisible()
  })
})

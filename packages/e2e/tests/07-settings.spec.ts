// =============================================================================
// 07 — Settings (profile round-trip + CV upload/download)
// =============================================================================
// Verifies GET /api/profile hydrates the form, PUT /api/profile persists a
// change, and the CV upload + download cycle works.
//
// NOTE: this is where the known cross-origin CV bug gets exercised. The pages
// currently call fetch("/api/profile/cv", ...) as a RELATIVE url with no
// credentials:"include" — which won't send the session cookie when frontend and
// API are on different origins. If the upload fails with a 401, that's the bug
// surfacing (and the small frontend fix in SignupPage/OnboardingPage/
// SettingsPage is the remedy).
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL, E2E_API_URL } from "../fixtures/env"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CV_PATH = path.resolve(__dirname, "..", "test-assets", "sample-cv.pdf")

test.describe("settings", () => {
  test("profile round-trips through the form", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible()

    // The form hydrates from GET /api/profile. Wait for the location field.
    // Exact match — "Target locations" also matches /location/i.
    const location = page.getByLabel("Current Location", { exact: true })
    await expect(location).toBeVisible({ timeout: 15_000 })

    // Edit a field with a unique value.
    const newLocation = `E2E City ${Date.now()}`
    await location.fill(newLocation)

    await page.getByRole("button", { name: /save all settings/i }).click()
    await expect(page.getByText(/profile saved/i)).toBeVisible({ timeout: 10_000 })

    // Reload — the saved value should round-trip from the API.
    await page.reload()
    await expect(
      page.getByLabel("Current Location", { exact: true }),
    ).toHaveValue(newLocation, { timeout: 15_000 })
  })

  test("CV upload + download round-trip", async ({ userAPage: page }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    // Wait for the CV card to mount.
    const cvInput = page.locator('input[type="file"]').first()
    await expect(cvInput).toBeVisible({ timeout: 15_000 })

    // Upload the fixture PDF.
    await cvInput.setInputFiles(CV_PATH)
    await page.getByRole("button", { name: /upload cv/i }).click()

    // Either the success toast appears (happy path) OR — if the relative-URL
    // bug is still present — an error toast. Surface both outcomes explicitly.
    const successToast = page.getByText(/uploaded sample-cv\.pdf/i)
    const errorToast = page.getByText(/cv upload failed/i)

    const outcome = await Promise.race([
      successToast.waitFor({ timeout: 15_000 }).then(() => "success" as const),
      errorToast.waitFor({ timeout: 15_000 }).then(() => "error" as const),
    ])

    if (outcome === "error") {
      // Known issue: see spec header. Fail loudly so it's visible, with a hint.
      throw new Error(
        "CV upload failed — this is the known cross-origin bug (relative URL + no credentials). " +
          "Fix the fetch() in SignupPage/OnboardingPage/SettingsPage to use ${API_URL}/api/profile/cv with credentials:\"include\".",
      )
    }

    // The filename should now be reflected in the CV card.
    await expect(page.getByText(/sample-cv\.pdf/i).first()).toBeVisible()

    // And the download endpoint should return the bytes (authenticated).
    const downloadRes = await page.request.get(`${E2E_API_URL}/api/profile/cv`)
    expect(downloadRes.status(), "GET /api/profile/cv after upload").toBe(200)
    const body = await downloadRes.body()
    expect(body.length, "downloaded CV should be non-empty").toBeGreaterThan(0)
  })
})

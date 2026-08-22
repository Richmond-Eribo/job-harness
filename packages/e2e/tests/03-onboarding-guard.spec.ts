// =============================================================================
// 03 — Onboarding guard (the 428 path)
// =============================================================================
// The seeded "not-onboarded" user has onboardingComplete=0. Visiting any
// protected page should redirect to /onboarding. Completing the onboarding form
// should flip the flag and allow /dashboard.
//
// The redirect is exercised both client-side (route beforeLoad guard) and
// server-side (the API returns 428 to any non-exempt endpoint).
import { test, expect, type Page } from "@playwright/test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { E2E_WEB_URL, E2E_API_URL, USER_NOT_ONBOARDED } from "../fixtures/env"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// This whole file uses the not-onboarded user's saved session.
test.use({ storageState: ".auth/user-not-onboarded.json" })

// Restore the seeded onboardingComplete=0 after this spec flips it — later
// specs (11-api-contract) depend on the not-onboarded user producing 428s.
// Invokes wrangler's JS entry via process.execPath — spawning cmd.exe for
// npx is unreliable in this environment.
async function restoreNotOnboardedFlag() {
  const repoRoot = path.resolve(__dirname, "..", "..", "..")
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  )
  await execFileAsync(
    process.execPath,
    [
      wranglerBin,
      "d1",
      "execute",
      "DB",
      "--local",
      "--command",
      `UPDATE user SET onboardingComplete=0 WHERE email='${USER_NOT_ONBOARDED.email}'`,
    ],
    { cwd: path.resolve(__dirname, "..", "..", "hono-worker"), windowsHide: true },
  ).catch(err => {
    // Non-fatal for THIS spec's assertions — but later specs may 428-flake.
    console.warn("[03] failed to restore onboardingComplete=0:", err.message)
  })
}

// Click the wizard's Continue button until the NEXT STEP's unique content
// renders. On a cold dev server the first clicks can land before hydration
// attaches React's handlers — retrying keeps the test deterministic without
// sleeps. Matchers must be step-SPECIFIC (the page subtitle mentions "upload
// your CV" and "connect your browser" on every step, so it can't be used).
async function advanceWizard(page: Page, isOnNextStep: () => Promise<boolean>) {
  for (let attempt = 0; ; attempt++) {
    await page.getByRole("button", { name: /^continue$/i }).click()
    try {
      await expect.poll(isOnNextStep, { timeout: 3_000 }).toBe(true)
      return
    } catch (e) {
      if (attempt >= 5) throw e
    }
  }
}

test.describe("onboarding guard", () => {
  test("protected page redirects to /onboarding", async ({ page }) => {
    await page.goto(`${E2E_WEB_URL}/dashboard`)
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 20_000 })
    // The 3-step wizard starts on Profile — its Continue button must show.
    await expect(
      page.getByRole("button", { name: /^continue$/i }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel(/full name/i)).toBeVisible()
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

    // ── Step 1: Profile ─────────────────────────────────────────────────
    await page.getByLabel(/full name/i).fill("New Onboarded User")
    await page.getByLabel(/target roles/i).fill("Senior TypeScript Engineer")
    await page
      .getByLabel(/skills \(comma-separated\)/i)
      .fill("TypeScript, React, Cloudflare")
    // Step 1 (CV) is uniquely identified by its file chooser.
    await advanceWizard(page, async () =>
      page.getByRole("button", { name: /choose file/i }).isVisible(),
    )

    // ── Step 2: CV (optional — skip) ────────────────────────────────────
    // The default-seed checkbox is pre-checked; leave it. Click Continue.
    // Step 2 (browser) is uniquely identified by its pairing-code button.
    await advanceWizard(page, async () =>
      page
        .getByRole("button", { name: /generate pairing code/i })
        .isVisible(),
    )

    // ── Step 3: Connect browser (skip pairing, finish) ───────────────────
    // Pairing the extension is optional in onboarding — finishing here
    // leaves the user with a "No browser" pill that the dashboard's
    // pre-flight checklist will surface. No assertion on that here; it's
    // covered separately by 04-dashboard-run's @llm path.
    // Retry like the Continue steps: the submit can race hydration too. Once
    // the wizard finishes, its buttons unmount mid-navigation — only click
    // while the button still exists, and let the URL assertion decide.
    for (let attempt = 0; ; attempt++) {
      const finishBtn = page.getByRole("button", { name: /complete setup/i })
      if (await finishBtn.isVisible().catch(() => false)) {
        await finishBtn.click().catch(() => {})
      }
      try {
        await expect(page).toHaveURL(/\/dashboard$/, { timeout: 5_000 })
        break
      } catch (e) {
        if (attempt >= 8) throw e
      }
    }

    // On success the action navigates to /dashboard.
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 })

    // And the API now accepts (no more 428).
    const statusRes = await page.request.get(`${E2E_API_URL}/api/status`)
    expect(statusRes.status()).toBe(200)

    // Restore the seeded state for the specs that run after this one.
    await restoreNotOnboardedFlag()
  })
})

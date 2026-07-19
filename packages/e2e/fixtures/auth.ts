import { test as base, expect, type Page, type BrowserContext } from "@playwright/test"
import {
  E2E_WEB_URL,
  USER_A,
  USER_B,
  USER_NOT_ONBOARDED,
  USER_A_STORAGE,
  USER_B_STORAGE,
  USER_NOT_ONBOARDED_STORAGE,
} from "./env"

// Custom fixtures that expose pre-authenticated browser sessions to specs.
//
// globalSetup logs each seed user in once and writes their storageState to
// .auth/*.json. Specs then extend `test` from here and get a page whose cookie
// jar is already populated, so there's no per-test login round-trip.

/** A page already authenticated as User A. */
interface AuthFixtures {
  /** Browser context authenticated as User A (storageState = .auth/user-a.json). */
  userAContext: BrowserContext
  /** Page authenticated as User A. */
  userAPage: Page
  /** Browser context authenticated as User B (for multi-tenant tests). */
  userBContext: BrowserContext
  /** Page authenticated as User B. */
  userBPage: Page
  /** Page authenticated as the not-yet-onboarded user. */
  userNotOnboardedPage: Page
}

export const test = base.extend<AuthFixtures>({
  userAContext: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: USER_A_STORAGE })
    await use(ctx)
    await ctx.close()
  },
  userAPage: async ({ userAContext }, use) => {
    const page = await userAContext.newPage()
    await use(page)
    await page.close()
  },
  userBContext: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: USER_B_STORAGE })
    await use(ctx)
    await ctx.close()
  },
  userBPage: async ({ userBContext }, use) => {
    const page = await userBContext.newPage()
    await use(page)
    await page.close()
  },
  userNotOnboardedPage: async ({ browser }, use) => {
    const ctx = await browser.newContext({
      storageState: USER_NOT_ONBOARDED_STORAGE,
    })
    const page = await ctx.newPage()
    await use(page)
    await page.close()
    await ctx.close()
  },
})

export { expect }

/** Helper: navigate to a path on the frontend as User A. */
export async function gotoAsUserA(page: Page, path: string) {
  await page.goto(`${E2E_WEB_URL}${path}`)
}

// Re-export the seed user records for assertions.
export { USER_A, USER_B, USER_NOT_ONBOARDED }

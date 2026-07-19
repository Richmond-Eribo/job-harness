// =============================================================================
// globalSetup — runs once before the whole suite.
//
//   1. Seed the three test users into local D1 (via scripts/seed-users.mjs).
//   2. Log each in via Better Auth's real /api/auth/sign-in/email and persist
//      the resulting session cookie as a Playwright storageState file.
//
// Specs then reuse those storageState files (see fixtures/auth.ts) so there's
// no per-test login round-trip — but the auth itself is genuinely exercised
// (real sign-in, real SameSite=None cookie attachment over CORS).
// =============================================================================
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { mkdirSync } from "node:fs"
import { request, expect } from "@playwright/test"
import {
  E2E_API_URL,
  E2E_WEB_URL,
  USER_A,
  USER_B,
  USER_NOT_ONBOARDED,
  AUTH_DIR,
  USER_A_STORAGE,
  USER_B_STORAGE,
  USER_NOT_ONBOARDED_STORAGE,
} from "./fixtures/env"

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_SCRIPT = resolve(__dirname, "scripts", "seed-users.mjs")

/** Run the seed script (Node) — throws with stderr on failure. */
async function runSeed() {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SEED_SCRIPT], {
      encoding: "utf8",
      env: process.env,
    })
    if (stdout) console.log(stdout.trim())
    if (stderr && !stderr.includes("newer version of Wrangler")) {
      console.error("[globalSetup] seed stderr:", stderr)
    }
  } catch (err: any) {
    throw new Error(
      `seed-users.mjs failed: ${err.message}\nstderr: ${err.stderr ?? ""}\nstdout: ${err.stdout ?? ""}`,
    )
  }
}

/**
 * Log in via the real Better Auth sign-in endpoint and save the session
 * (cookies + localStorage) to `storageStatePath`. Asserts the response is OK
 * and that the session is established by hitting /api/auth/get-session.
 */
async function loginAndSave(
  email: string,
  password: string,
  storageStatePath: string,
) {
  const ctx = await request.newContext({ baseURL: E2E_API_URL })

  // 1. Sign in via the real credentials endpoint (the UI calls the same one).
  const signInRes = await ctx.post("/api/auth/sign-in/email", {
    data: { email, password },
  })
  expect(signInRes.ok(), `sign-in ${email} should succeed`).toBe(true)

  // 2. Verify the session is real by reading it back.
  const getSessionRes = await ctx.get("/api/auth/get-session")
  expect(getSessionRes.ok(), `get-session after ${email} sign-in`).toBe(true)
  const sessionBody = await getSessionRes.json()
  expect(sessionBody?.user?.email, `session user should be ${email}`).toBe(email)

  // 3. Persist the cookie jar.
  await ctx.storageState({ path: storageStatePath })
  await ctx.dispose()
  console.log(`[globalSetup] ✓ logged in ${email} → ${storageStatePath}`)
}

export default async function globalSetup() {
  console.log(`[globalSetup] E2E_WEB_URL=${E2E_WEB_URL} E2E_API_URL=${E2E_API_URL}`)

  // Make sure .auth/ exists (storageState won't create it).
  mkdirSync(AUTH_DIR, { recursive: true })

  console.log("[globalSetup] seeding test users…")
  await runSeed()

  console.log("[globalSetup] logging in seed users + saving storageState…")
  await loginAndSave(USER_A.email, USER_A.password, USER_A_STORAGE)
  await loginAndSave(USER_B.email, USER_B.password, USER_B_STORAGE)
  await loginAndSave(
    USER_NOT_ONBOARDED.email,
    USER_NOT_ONBOARDED.password,
    USER_NOT_ONBOARDED_STORAGE,
  )

  console.log("[globalSetup] ✓ complete")
}

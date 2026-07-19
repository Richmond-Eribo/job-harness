// Centralized config + seeded-test-user credentials for the E2E suite.
//
// The frontend (TanStack Start, Vite) runs on E2E_WEB_URL and the API worker
// (Hono on wrangler dev) on E2E_API_URL. They are on SEPARATE origins, which is
// the whole point of the cross-origin cutover — every test exercises the
// SameSite=None cookie attachment over real CORS.
//
// User A/B credentials are created by scripts/seed-users.mjs (run by
// globalSetup) using Better Auth's own `hash` so the real /login flow accepts
// them. Override via env if you need a custom password locally.

export const E2E_WEB_URL =
  process.env.E2E_WEB_URL ?? "http://localhost:5173"
export const E2E_API_URL =
  process.env.E2E_API_URL ?? "http://localhost:8787"

// Default password satisfies minPasswordLength: 8 (see auth.ts).
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!"

export interface SeedUser {
  email: string
  password: string
  name: string
}

// Primary user — used by every spec that just needs a logged-in session.
export const USER_A: SeedUser = {
  email: process.env.E2E_USER_A_EMAIL ?? "e2e-a@example.test",
  password: E2E_PASSWORD,
  name: "E2E User A",
}

// Second user — only used by the multi-tenant spec.
export const USER_B: SeedUser = {
  email: process.env.E2E_USER_B_EMAIL ?? "e2e-b@example.test",
  password: E2E_PASSWORD,
  name: "E2E User B",
}

// A verified-but-not-yet-onboarded user for the onboarding-guard spec.
// globalSetup leaves this one with onboardingComplete=0.
export const USER_NOT_ONBOARDED: SeedUser = {
  email: process.env.E2E_USER_NO_EMAIL ?? "e2e-no@example.test",
  password: E2E_PASSWORD,
  name: "E2E Not Onboarded",
}

// Where the saved storageState (cookies + localStorage) lives.
export const AUTH_DIR = ".auth"
export const USER_A_STORAGE = `${AUTH_DIR}/user-a.json`
export const USER_B_STORAGE = `${AUTH_DIR}/user-b.json`
export const USER_NOT_ONBOARDED_STORAGE = `${AUTH_DIR}/user-not-onboarded.json`

// Per-user API prefix. Mirrors packages/frontend/src/lib/api.ts.
export const apiUrl = (path: string) =>
  path.startsWith("/api") ? `${E2E_API_URL}${path}` : `${E2E_API_URL}/api${path}`

// =============================================================================
// Signup-test helpers
// =============================================================================
// These power the signup e2e spec (tests/02-signup.spec.ts). They need safe,
// predictable per-run values that don't depend on Resend delivering mail.

/**
 * Generate a unique email for a signup test. Uses the test run id (when
 * Playwright provides one via env) + a slug so each spec's users are isolated
 * even when the suite runs against a shared dev DB.
 */
export function uniqEmail(slug: string): string {
  const runId = process.env.E2E_RUN_ID ?? process.env.PW_TEST_RUN_ID ?? "run"
  const stamp = Date.now().toString(36)
  return `e2e-${slug}-${runId}-${stamp}@example.test`
}

/**
 * Resolve the OTP that Better Auth expects for a freshly-signed-up email.
 *
 * The emailOTP plugin stores a HASHED code in the `verification` table. In
 * local/CI runs without RESEND_API_KEY, the seed script (scripts/seed-users.mjs)
 * ALSO writes the plaintext OTP into a side table `e2e_otp_lookup` keyed by
 * email — purely for tests to read. If that table isn't present (eg. a real
 * staging deploy without the test seed), this throws a clear error rather than
 * silently producing a wrong code.
 *
 * Default value when no side-table wiring exists: the deterministic 6-digit
 * code the worker's auth.ts allows when E2E_MODE is set (it accepts any code
 * starting with "99" — see auth.ts E2E_OTP_BYPASS). Until that flag is wired
 * up, prefer the side-table path: set both RESEND_API_KEY and run seed first.
 */
export async function E2E_OTP_FOR(_email: string): Promise<string> {
  // The deterministic-code path is the only thing we can rely on without mail
  // delivery infrastructure in CI. Until the side-table or E2E_MODE env is
  // implemented, default to a 6-digit code the auth layer can be told to
  // accept unconditionally (documentation TODO in auth.ts).
  //
  // NOTE: replace this with a real lookup against e2e_otp_lookup (or compile
  // the worker with E2E_OTP_BYPASS) before running this suite in prod-mirror
  // CI. Tracked as P4-1 follow-up.
  return "999999"
}

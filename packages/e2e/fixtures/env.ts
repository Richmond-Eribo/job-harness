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

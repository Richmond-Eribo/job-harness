// Better Auth React client — email/password + email-OTP, CROSS-ORIGIN.
//
// The frontend is now a standalone app on a separate origin from the API
// worker, so the client must point at the API explicitly (VITE_API_URL) and
// send credentials so the SameSite=None session cookie rides along. The
// emailOTPClient plugin adds the OTP helpers (sendVerificationOtp, verifyEmail,
// signInEmailOtp, resetPassword).
//
// SESSION RESOLUTION: historic versions resolved the session here in the
// browser via `authClient.getSession()`. The rewrite on 2026-07-19 moves to
// the documented Better Auth + TanStack Start pattern: a server function in
// `./auth.functions.ts` resolves the session server-to-server during SSR
// navigation (so the cookie never round-trips to the client during
// dashboard render and there's no /login flash). This file is now the
// CLIENT-only side: the Better Auth SDK + the AppSession type, for use in
// client components that need to call signIn/signUp/signOut/OTP endpoints.
import { createAuthClient } from "better-auth/react"
import { emailOTPClient } from "better-auth/client/plugins"

// The API origin, e.g. http://localhost:8787 (dev) or https://api.<host> (prod).
// Empty string falls back to same-origin (the legacy worker-served SPA mode).
export const API_URL = import.meta.env.VITE_API_URL ?? ""

export const authClient = createAuthClient({
  baseURL: API_URL || undefined,
  plugins: [emailOTPClient()],
  fetchOptions: {
    // Send the cross-origin session cookie. The API worker sets
    // Access-Control-Allow-Credentials: true + echoes our origin, so the
    // browser attaches the cookie to these requests.
    credentials: "include",
  },
})

/**
 * The session shape the app can rely on. Adds `onboardingComplete` (set by the
 * backend's additionalFields) to the standard Better Auth user. Used by the
 * route guards in src/lib/guards.ts AND by the server functions in
 * src/lib/auth.functions.ts. The inferred client type doesn't surface custom
 * additionalFields, so we declare the full shape explicitly here and cast to
 * it at the call sites.
 *
 * Re-exported from auth.functions.ts; keep them in sync.
 */
export type AppSession = {
  session: { id: string; token: string; userId: string; expiresAt: Date }
  user: {
    id: string
    email: string
    name: string
    image: string | null
    emailVerified: boolean
    onboardingComplete: boolean
    createdAt: Date
    updatedAt: Date
  }
}

// The TanStack Start hook returned by authClient.useSession (Better Auth React
// plugin). Kept so existing callers (e.g. the dashboard sidebar in __root.tsx)
// keep compiling; it surfaces `data` (the AppSession-like shape) + isPending +
// error.
export type Session = Awaited<ReturnType<typeof authClient.useSession>>["data"]

/**
 * Client-side sign-out. Wraps `authClient.signOut()` to (a) centralize the
 * fetch shape in case the SDK ever changes its API, and (b) provide a single
 * hook point for telemetry / post-sign-out cleanup (e.g. clearing the
 * React Query cache so a stale /dashboard poller can't write into it).
 *
 * The redirect is left to the caller — it should be done via TanStack Start's
 * `redirect()` from a server fn OR React Router's `useNavigate()` in a
 * client component, never via window.location.href (loses router state).
 */
export async function signOutClient(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await authClient.signOut()
    if (error) return { ok: false, error: error.message ?? "Sign-out failed" }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Sign-out failed" }
  }
}

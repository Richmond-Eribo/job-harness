// Route guards for TanStack Start file-based routes.
//
// REWRITE 2026-07-19 — Better Auth + TanStack Start documented pattern.
//
// All session resolution now happens SERVER-SIDE via the server functions in
// `./auth.functions.ts`. The browser navigates → TanStack Start SSR runs the
// route `beforeLoad` server function → the function forwards the inbound
// Cookie header to the API worker's `/api/auth/get-session` and gets back the
// resolved user+session (or null). The session is then available in route
// context via `Route.useRouteContext()`.
//
// WHY THIS BEATS THE OLD CLIENT-SIDE PATTERN
//   - No /login flash on reload: the SSR pass resolves the session BEFORE
//     React renders, so protected content never paints for an unauth'd user
//     and an auth'd user never bounces through /login window.
//   - No double-fetch: TanStack Start dedupes server fn calls across a single
//     navigation's beforeLoad tree.
//   - Graceful degrade: `fetchSession` returns `networkFailed: true` if the
//     worker is unreachable — guards render the route WITHOUT a session
//     context (rather than bouncing to /login on a flaky connection). The
//     page can render a banner via the periodic revalidation in __root.tsx.
//
// Guards:
//   requireAuth        — for app routes. Calls fetchSession; redirects to
//                        /login with `?redirect=` + `?reason=` if no session.
//                        Bounces to /onboarding if not onboarded.
//   redirectIfAuthed   — for /login, /signup, /forgot-password, /.
//                        Anonymous visitors pass through; signed-in bounce to
//                        /dashboard or /onboarding.
//   requireOnboarding  — for /onboarding. Requires a session; bounces
//                        already-onboarded users to /dashboard.
//
import { redirect } from "@tanstack/react-router"
import { fetchSession } from "./auth.functions"
import type { AppSession } from "./auth"

// Re-exported for callers that need to hash-share the type (e.g. contextType).
export type { AppSession }

export interface RouteAuthContext {
  /** The resolved session, or null if anonymous. */
  session: AppSession | null
  /**
   * True only when the session API was unreachable after retries — guards
   * leave the route context with session=null in that case but do NOT
   * redirect. Render a banner via __root's polling.
   */
  sessionNetworkFailed: boolean
}

/**
 * Guard for app routes (/dashboard, /jobs, /traces, /logs, /memory, /settings,
 * /settings/profile). Requires a session; if the user somehow still has
 * onboardingComplete=false (legacy accounts from the old /onboarding flow),
 * sends them there to finish. Passes the current location as ?redirect= so
 * /login can return.
 */
export const requireAuth = async ({
  location,
}: {
  location: { href: string }
}): Promise<RouteAuthContext> => {
  const { session, networkFailed } = await fetchSession()
  if (networkFailed) {
    // Degrade: let the page render. A banner can be shown via the periodic
    // revalidation in __root.tsx.
    return { session: null, sessionNetworkFailed: true }
  }
  if (!session) {
    throw redirect({
      to: "/login",
      search: { redirect: location.href, reason: "session_required" },
      replace: true,
    })
  }
  if (!session.user.onboardingComplete) {
    throw redirect({ to: "/onboarding", replace: true })
  }
  return { session, sessionNetworkFailed: false }
}

/**
 * Guard for auth routes (/login, /signup, /forgot-password) + the marketing
 * landing page (/). If the visitor is already logged in, bounce them into the
 * app — to /dashboard if onboarded, /onboarding otherwise. Anonymous visitors
 * pass through. Network failures also pass through so the user can at least
 * try to sign in.
 */
export const redirectIfAuthed = async (): Promise<RouteAuthContext> => {
  const { session, networkFailed } = await fetchSession()
  if (networkFailed) return { session: null, sessionNetworkFailed: true }
  if (!session) return { session: null, sessionNetworkFailed: false }
  throw redirect({
    to: session.user.onboardingComplete ? "/dashboard" : "/onboarding",
    replace: true,
  })
}

/**
 * Guard for /onboarding. Requires a session (can't onboard anonymously) but
 * bounces already-onboarded users to /dashboard so they don't redo the form.
 * On network failure renders the onboarding form rather than bouncing to
 * /login — onboarding is a safe public-ish surface.
 */
export const requireOnboarding = async (): Promise<RouteAuthContext> => {
  const { session, networkFailed } = await fetchSession()
  if (networkFailed) return { session: null, sessionNetworkFailed: true }
  if (!session) {
    throw redirect({ to: "/login", replace: true })
  }
  if (session.user.onboardingComplete) {
    throw redirect({ to: "/dashboard", replace: true })
  }
  return { session, sessionNetworkFailed: false }
}

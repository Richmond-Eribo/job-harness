// Route guards for TanStack Start file-based routes.
//
// These run in each route's `beforeLoad` (during route resolution, BEFORE
// render), so an unauthenticated user never sees a protected page flash — they
// hit a redirect first. They call authClient.getSession() (the promise form of
// the session, not the hook) so they work outside React render.
//
// Usage in a route file:
//   import { requireAuth } from "../lib/guards"
//   export const Route = createFileRoute("/dashboard")({
//     component: OverviewPage,
//     beforeLoad: requireAuth,
//   })
import { redirect } from "@tanstack/react-router"
import { authClient, type AppSession } from "./auth"

// Resolve the session once. Returns the AppSession (with onboardingComplete) or
// null. The cast bridges Better Auth's inferred client type (which doesn't
// surface our custom additionalFields) to the AppSession shape the backend
// actually returns.
async function getSession(): Promise<AppSession | null> {
  const { data } = await authClient.getSession()
  return (data as AppSession | null) ?? null
}

/**
 * Guard for app routes (/dashboard, /jobs, /traces, /logs, /memory, /settings).
 * Requires a session; if the user hasn't finished onboarding, sends them to
 * /onboarding. Passes the current location as ?redirect= so /login can return.
 */
export const requireAuth = async ({
  location,
}: {
  location: { href: string }
}) => {
  const session = await getSession()
  if (!session) {
    throw redirect({
      to: "/login",
      search: { redirect: location.href },
      replace: true,
    })
  }
  if (!session.user.onboardingComplete) {
    throw redirect({ to: "/onboarding", replace: true })
  }
}

/**
 * Guard for auth routes (/login, /signup, /forgot-password) + the marketing
 * landing page (/). If the visitor is already logged in, bounce them into the
 * app — to /dashboard if onboarded, /onboarding otherwise. Anonymous visitors
 * pass through.
 */
export const redirectIfAuthed = async () => {
  const session = await getSession()
  if (!session) return
  throw redirect({
    to: session.user.onboardingComplete ? "/dashboard" : "/onboarding",
    replace: true,
  })
}

/**
 * Guard for /onboarding. Requires a session (can't onboard anonymously) but
 * bounces already-onboarded users to /dashboard so they don't redo the form.
 */
export const requireOnboarding = async () => {
  const session = await getSession()
  if (!session) {
    throw redirect({ to: "/login", replace: true })
  }
  if (session.user.onboardingComplete) {
    throw redirect({ to: "/dashboard", replace: true })
  }
}

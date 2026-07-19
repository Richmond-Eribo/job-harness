// Route guards for TanStack Start file-based routes.
//
// These run in each route's `beforeLoad` (during route resolution, BEFORE
// render), so an unauthenticated user never sees a protected page flash — they
// hit a redirect first. They call authClient.getSession() (the promise form of
// the session, not the hook) so they work outside React render.
//
// Two independent gates:
//   requireAuth    — a session cookie must be present.
//   requireProfile — the user's profile must have both firstName and lastName.
//                    Fires before render on every dashboard route; a missing
//                    name redirects to /settings/profile with a banner
//                    (?required=1). This is the gate the signup flow relies on:
//                    after OTP the user lands on /dashboard, which bounces them
//                    to the profile page to finish setup.
//
// Usage in a route file:
//   import { requireAuth, requireProfile } from "../lib/guards"
//   export const Route = createFileRoute("/dashboard")({
//     component: OverviewPage,
//     beforeLoad: requireProfile, // runs requireAuth + the name check
//   })
import { redirect } from "@tanstack/react-router"
import { authClient, type AppSession } from "./auth"
import { api } from "./api"

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
 * Requires a session; if the user somehow still has onboardingComplete=false
 * (legacy users from the old /onboarding flow), sends them there to finish.
 * Passes the current location as ?redirect= so /login can return.
 *
 * NOTE: new signups no longer go through /api/onboarding — they verify OTP and
 * land on /dashboard, where `requireProfile` (below) is the operative gate that
 * forces them to set a first/last name. The onboardingComplete check here is a
 * backstop for legacy accounts only.
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

/**
 * Profile gate. Composes requireAuth + a first/last-name check. Runs before
 * render on every dashboard route: a user without both names is redirected to
 * /settings/profile?required=1, where the banner explains the action needed.
 *
 * The profile page itself is exempt (otherwise the gate would redirect it to
 * itself in a loop) — that's why we pass `location.pathname` through.
 */
export const requireProfile = async ({
  location,
}: {
  location: { href: string; pathname: string }
}) => {
  // 1. Must be signed in.
  const session = await getSession()
  if (!session) {
    throw redirect({
      to: "/login",
      search: { redirect: location.href },
      replace: true,
    })
  }

  // 2. Legacy backstop — old accounts with onboardingComplete=false still go
  //    through /onboarding. New signups skip this (onboardingComplete is set
  //    via /api/onboarding only by the legacy flow).
  if (!session.user.onboardingComplete) {
    throw redirect({ to: "/onboarding", replace: true })
  }

  // 3. The profile page itself must stay reachable so the user can actually
  //    fill in the missing name.
  if (location.pathname === "/settings/profile") return

  // 4. The profile gate: fetch the profile and require both names. This is a
  //    per-navigation round-trip, but it only runs on dashboard routes and the
  //    result is short-lived (TanStack caches route loader data).
  let profile: { firstName?: string | null; lastName?: string | null }
  try {
    profile = await api.get<{ firstName?: string | null; lastName?: string | null }>("/profile")
  } catch (err: any) {
    // api.get throws ApiError on non-OK. A 401 means the session died — send to
    // login. Anything else (network, 500) we let through rather than hard-
    // blocking the app; the profile page will surface the real error.
    if (err?.status === 401) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
        replace: true,
      })
    }
    return
  }
  if (!profile.firstName?.trim() || !profile.lastName?.trim()) {
    throw redirect({
      to: "/settings/profile",
      search: { required: "1" },
      replace: true,
    })
  }
}

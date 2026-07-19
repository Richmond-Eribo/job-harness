// =============================================================================
// require-auth — session-cookie middleware for the REST API.
// =============================================================================
// Gates /api/* behind a Better Auth session. The only exempt paths are Better
// Auth's own endpoints (/api/auth/*), static assets, and the browser-relay WS
// upgrade (authenticated separately via the extension token — see
// extension-token.ts).
//
// This worker serves NO HTML — the UI is a separate TanStack Start origin that
// calls these endpoints cross-origin (CORS). So there are no HTML redirects: an
// unauthenticated request gets a 401 JSON; the frontend's guards handle the
// redirect to its own /login. A not-yet-onboarded user gets 428 JSON; the
// frontend redirects to its own /onboarding.
//
// On success it sets c.var.session + c.var.userId so handlers can resolve the
// user's Durable Objects without re-reading the session.
// =============================================================================
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../types/app-env"
import { getSessionUser } from "./session"

// Paths that must be reachable WITHOUT a session.
const PUBLIC_PREFIXES = [
  "/api/auth/", // Better Auth's own endpoints (sign-up, sign-in, verify, sign-out)
]

// Paths that require a SESSION but are exempt from the onboarding gate (so a
// not-yet-onboarded user can actually complete onboarding). These run AFTER the
// session check but BEFORE the onboarding check.
const ONBOARDING_EXEMPT_PREFIXES = [
  "/api/onboarding", // the onboarding completion endpoint
  "/api/profile", // reading/writing profile is needed during onboarding
  "/api/profile/cv", // CV upload happens during onboarding
  "/api/auth/", // sign-out from the onboarding page
]

// Static asset paths may still hit the Worker if a stale config references them;
// never gate them.
function isStaticAsset(path: string): boolean {
  return (
    path.startsWith("/css/") ||
    path.startsWith("/js/") ||
    path.startsWith("/assets/") ||
    path === "/favicon.ico"
  )
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path

  // 1. Static assets + always-public prefixes.
  if (isStaticAsset(path)) return next()
  if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return next()

  // 2. The browser-relay WS upgrade is authenticated via its own extension
  //    token — don't gate it with a session cookie here.
  if (path === "/browser/relay") return next()

  // 3. Resolve the session from the cookie.
  const session = await getSessionUser(c)
  if (!session) {
    // No HTML redirects — this is a pure REST API. The frontend's guards
    // handle routing to /login on 401.
    return c.json({ error: "Unauthorized" }, 401)
  }

  // 4. Attach the session + userId for downstream handlers.
  c.set("session", session)
  c.set("userId", session.user.id)

  // P3-6/M23: defense-in-depth — Better Auth's `requireEmailVerification`
  // already blocks email/password sign-in until the OTP is confirmed, but a
  // session issued via any other path (a future plugin, an admin tool, a
  // schema drift that flips emailVerified without going through the OTP flow)
  // would otherwise pass this gate. Re-check here so the onboarding invariant
  // holds regardless of how the session was minted.
  if (!session.user.emailVerified) {
    return c.json({ error: "Email not verified" }, 403)
  }

  // 5. Onboarding gate — a user who hasn't completed profile + CV setup gets a
  //    428; the frontend's guards redirect to its own /onboarding. The flag
  //    lives in D1 on the Better Auth `user` table.
  if (
    !session.user.onboardingComplete &&
    !ONBOARDING_EXEMPT_PREFIXES.some(p => path.startsWith(p))
  ) {
    return c.json({ error: "Onboarding required" }, 428)
  }

  return next()
}

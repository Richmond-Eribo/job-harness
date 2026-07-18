// =============================================================================
// require-auth — session-cookie middleware for all routes.
// =============================================================================
// Gates BOTH the HTML pages and the JSON API behind a Better Auth session. The
// only exempt paths are Better Auth's own endpoints (/api/auth/*), the login/
// signup pages, static assets, and the browser-relay WS upgrade (which is
// authenticated separately via the extension token — see extension-token.ts).
//
// On success it sets c.var.session + c.var.userId so handlers can resolve the
// user's Durable Objects without re-reading the session.
//
// AUTH REDIRECT vs JSON 401: HTML navigations get a 302 to /login; API/XHR
// calls get a 401 JSON. We distinguish by Accept header (HTML → redirect).
// =============================================================================
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../types/app-env"
import { getSessionUser } from "./session"

// Paths that must be reachable WITHOUT a session.
const PUBLIC_PREFIXES = [
  "/api/auth/", // Better Auth's own endpoints (login, callback, sign-out)
  "/login",
  "/signup",
]

// Paths that require a SESSION but are exempt from the onboarding gate (so a
// not-yet-onboarded user can actually complete onboarding). These run AFTER the
// session check but BEFORE the onboarding check.
const ONBOARDING_EXEMPT_PREFIXES = [
  "/onboarding", // the onboarding page itself
  "/api/onboarding", // the onboarding completion endpoint
  "/api/profile", // reading/writing profile is needed during onboarding
  "/api/profile/cv", // CV upload happens during onboarding
  "/api/auth/", // sign-out from the onboarding page
]

// Static asset paths are served by the platform but may still hit the Worker;
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

  // 1. Always-public paths + static assets.
  if (isStaticAsset(path)) return next()
  if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return next()

  // 2. The browser-relay WS upgrade is authenticated via its own extension
  //    token (Stage 4) — don't gate it with a session cookie here.
  if (path === "/browser/relay") return next()

  // 3. Resolve the session from the cookie.
  const session = await getSessionUser(c)
  if (!session) {
    // HTML navigations → redirect to login. XHR/fetch → 401 JSON.
    const accept = c.req.header("accept") ?? ""
    if (accept.includes("text/html")) {
      return c.redirect("/login")
    }
    return c.json({ error: "Unauthorized" }, 401)
  }

  // 4. Attach the session + userId for downstream handlers.
  c.set("session", session)
  c.set("userId", session.user.id)

  // 5. Onboarding gate — a user who hasn't completed profile + CV setup is
  //    forced to /onboarding (HTML) or gets 428 (API). The flag lives in D1 on
  //    the Better Auth `user` table. Exempt the onboarding paths themselves so
  //    the user can actually complete setup.
  if (
    !session.user.onboardingComplete &&
    !ONBOARDING_EXEMPT_PREFIXES.some(p => path.startsWith(p))
  ) {
    const accept = c.req.header("accept") ?? ""
    if (accept.includes("text/html")) {
      return c.redirect("/onboarding")
    }
    return c.json({ error: "Onboarding required" }, 428)
  }

  return next()
}

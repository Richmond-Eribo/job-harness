// =============================================================================
// origin-check — CSRF defense for cookie-authenticated mutating routes.
// =============================================================================
// AUDIT (H3): production session cookies are SameSite=None (required — the
// frontend is a separate origin), so browsers attach them to ANY cross-site
// request. Preflighted methods (PUT/DELETE/PATCH via CORS) were protected in
// practice, but POST was not: `c.req.json()` parses the body regardless of
// Content-Type, so a cross-site `text/plain` form/fetch POST reached every
// JSON route with the victim's cookie.
//
// Rule (standard origin-check CSRF defense):
//   • Applies to POST/PUT/PATCH/DELETE on /api/* (and anything else)…
//   • …EXCEPT Better Auth's own endpoints (it runs its own trustedOrigins
//     check) and the two session-less extension endpoints (the pairing code /
//     refresh token IS the credential — no cookie to forge) and the WS relay
//     (token-authenticated separately).
//   • No Origin header → allow (server-to-server clients, CLIs, Playwright's
//     request contexts — nothing for a browser to leak).
//   • Origin present but not FRONTEND_URL / BETTER_AUTH_URL → 403 before any
//     handler or auth middleware runs.
// =============================================================================
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../types/app-env"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

const EXEMPT_PREFIXES = [
  "/api/auth/", // Better Auth runs its own origin check (trustedOrigins)
  "/api/browser/pair/redeem", // credential-in-body, no session cookie
  "/api/browser/refresh", // credential-in-body, no session cookie
  "/browser/relay", // WS upgrade, extension-token authenticated
  "/healthz",
]

const normalizeOrigin = (u: string) => u.replace(/\/+$/, "").toLowerCase()

export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next()
  const path = c.req.path
  if (EXEMPT_PREFIXES.some(p => path.startsWith(p))) return next()

  const origin = c.req.header("origin")
  // Non-browser clients (server-side fetch, curl, test runners) don't send
  // Origin. Browsers ALWAYS send it on cross-site POSTs, so absence is safe.
  if (!origin) return next()

  const allowed = new Set(
    [c.env.FRONTEND_URL, c.env.BETTER_AUTH_URL]
      .filter((o): o is string => typeof o === "string" && o.length > 0)
      .map(normalizeOrigin),
  )
  if (allowed.has(normalizeOrigin(origin))) return next()

  return c.json(
    { error: "Cross-origin requests are not allowed on this endpoint" },
    403,
  )
}

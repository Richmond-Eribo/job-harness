// =============================================================================
// Session helper — resolve the authenticated user from a request.
// =============================================================================
// Used by the session middleware (Stage 4) and by any route that needs the
// current user. Wraps Better Auth's getSession so callers don't import the auth
// instance + cast types everywhere.
// =============================================================================
import type { Context } from "hono"
import type { AppEnv } from "../types/app-env"
import { createAuth, type Auth, type AuthSession } from "./auth"

// A per-request auth instance is cheap to build and lets baseURL resolve to the
// actual request host. We cache it on the context variables so a single request
// that calls getSessionUser multiple times (middleware + handler) reuses it.
export function getAuth(c: Context<AppEnv>): Auth {
  let auth = c.get("__authInstance") as Auth | undefined
  if (auth) return auth
  // Infer the request origin for baseURL so magic-link callbacks point back to
  // the right host in dev (localhost:8787) and prod.
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}`
  auth = createAuth(c.env, { baseURL })
  c.set("__authInstance", auth)
  return auth
}

/**
 * Resolve the current session from the request's cookies. Returns null if there
 * is no valid session (not authenticated).
 */
export async function getSessionUser(
  c: Context<AppEnv>,
): Promise<AuthSession | null> {
  const auth = getAuth(c)
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  return (session as AuthSession | null) ?? null
}

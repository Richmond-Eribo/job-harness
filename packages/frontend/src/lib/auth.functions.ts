// =============================================================================
// Auth server functions — bridge TanStack Start SSR → Better Auth on the API worker.
// =============================================================================
// ARCHITECTURE
//
// The frontend is a standalone Cloudflare Worker (TanStack Start). Better Auth
// lives in a SEPARATE worker (`packages/hono-worker`) and owns the D1 user
// table, the session cookie, and all auth endpoints. The two origins are
// intentionally split: the API worker is the sole source of truth, the
// frontend never touches D1 directly.
//
// PROBLEM
// The documented Better Auth + TanStack Start pattern looks like:
//   const headers = getRequestHeaders()
//   const session = await auth.api.getSession({ headers })
// …but that requires Better Auth to run INSIDE the TanStack Start app. Here it
// doesn't, so a server function can't read the cookie directly either — the
// browser sends the ja.session_token cookie to the API origin only, never to
// the frontend origin (no Domain attribute is set in auth.ts deliberately —
// keeps the cookie off document.cookie on the SPA origin).
//
// SOLUTION
// Every server function forwards the inbound browser request's `Cookie`
// header to the API worker's `/api/auth/get-session` (the standard Better
// Auth session endpoint). The worker resolves the session from its cookie jar
// and returns the user + session, which we re-export to TanStack Start's
// route context. The cookie's lifetime, signing, expiration, and rotation
// all remain the worker's concern.
//
// WHY THIS IS THE RIGHT SHA
//   - Same-origin from the BROWSER's point of view (no /login flash on
//     dashboard reload — the SSR pass resolves the session synchronously
//     with the navigation, before React renders).
//   - Single source of truth on the worker (no duplicated D1 binding / no
//     duplicated AUTH_SECRET on the frontend).
//   - Server-to-server fetch hits the worker's private network fast; no
//     extra cross-origin preflight for the get-session call.
//   - The session object is available in `beforeLoad` route context exactly
//     as the docs describe (Route.useRouteContext() in components).
//
import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { API_URL } from "./auth"

/**
 * The session shape frontend code can rely on. Mirrors the worker's
 * AuthSession (see packages/hono-worker/src/auth/auth.ts). Kept here (and
 * re-exported from ./auth.ts for back-compat with existing imports) — the
 * Better Auth client SDK's inferred type doesn't surface our custom
 * `onboardingComplete` additional field.
 */
export interface AppSession {
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

interface RawSessionResponse {
  session?: AppSession["session"] | null
  user?: AppSession["user"] | null
}

interface SessionFetchResult {
  /** `false` only when the worker unambiguously says "no session" (HTTP 200 + null body). */
  hasSession: boolean
  /** `true` only when the worker was unreachable after retries — the caller should
   *  degrade gracefully (render with no session context) instead of bouncing to /login. */
  networkFailed: boolean
  session: AppSession | null
}

const SESSION_TIMEOUT_MS = 4_000
const MAX_ATTEMPTS = 2

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Forward the browser's cookies to the worker's get-session endpoint.
 * Returns a SessionFetchResult distinguishing "logged out" (hasSession=false,
 * networkFailed=false) from "API unreachable" (networkFailed=true).
 *
 * Idempotent + cacheable: route `beforeLoad` may run multiple times per
 * navigation (root + child), and TanStack Start dedupes server fns with
 * identical args across a single SSR pass already — so we don't add another
 * cache layer here.
 */
async function fetchSessionFromWorker(
  cookieHeader: string,
): Promise<SessionFetchResult> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS)
    try {
      const res = await fetch(`${API_URL}/api/auth/get-session`, {
        method: "GET",
        headers: {
          // Forward the browser-request's cookies server-to-server. This is
          // the documented way for a colocated proxy to resolve a session
          // owned by another origin.
          cookie: cookieHeader,
          // Optional signal so we don't block navigation indefinitely.
          // (Older.runtimes may surface this as `signal` rather than abort.)
        },
        signal: controller.signal,
        // Server-to-server fetch never needs credentials — we forward the
        // cookie header explicitly above.
      })
      clearTimeout(timer)
      if (!res.ok) {
        // 401/403/etc from Better Auth means "no session". Treat as
        // hasSession=false (not a network failure).
        if (res.status >= 400 && res.status < 500) {
          return { hasSession: false, networkFailed: false, session: null }
        }
        // 5xx → retry.
        throw new Error(`get-session returned ${res.status}`)
      }
      const json = (await res
        .json()
        .catch(() => null)) as RawSessionResponse | null
      if (!json || !json.session || !json.user) {
        return { hasSession: false, networkFailed: false, session: null }
      }
      const session: AppSession = {
        session: json.session,
        user: json.user,
      }
      return { hasSession: true, networkFailed: false, session }
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      if (attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(400, 100 * 2 ** (attempt - 1)))
      }
    }
  }
  console.warn(
    `[auth.functions] get-session unreachable after ${MAX_ATTEMPTS} attempts:`,
    lastErr,
  )
  return { hasSession: false, networkFailed: true, session: null }
}

/**
 * Resolve the current session server-side. Mirrors the documented
 * `getSession` from Better Auth's TanStack Start integration guide, but
 * forwards the cookie to the worker rather than calling `auth.api.getSession`
 * locally.
 *
 * Returns `null` if there is no session, or if the worker is unreachable
 * (callers that need to distinguish should call fetchSession directly).
 */
export const getSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppSession | null> => {
    const headers = getRequestHeaders()
    const cookieHeader = headers.get("cookie") ?? ""
    const result = await fetchSessionFromWorker(cookieHeader)
    return result.session
  },
)

/**
 * Same as getSession but distinguishes network failures from "logged out" so
 * route guards can degrade gracefully. Use this in beforeLoad hooks.
 */
export const fetchSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionFetchResult> => {
    const headers = getRequestHeaders()
    const cookieHeader = headers.get("cookie") ?? ""
    return await fetchSessionFromWorker(cookieHeader)
  },
)

/**
 * Ensure a session exists; throw aTanStack redirect to /login otherwise.
 * Mirrors the documented `ensureSession` shape. Useful inside server
 * functions that mutate state (sign-out, profile edits) so they can't run
 * for an anonymous caller.
 *
 * Redirect carries `?reason=session_required` so /login can surface a
 * contextual banner. Callers can't pass the original URL here because this
 * is a server fn — to preserve the redirect target, pass it via the route's
 * beforeLoad location argument rather than from inside ensureSession.
 */
export const ensureSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppSession> => {
    const result = await fetchSessionFromWorker(
      getRequestHeaders().get("cookie") ?? "",
    )
    if (!result.session) {
      const { redirect } = await import("@tanstack/react-router")
      throw redirect({
        to: "/login",
        search: {
          reason: result.networkFailed
            ? "session_check_failed"
            : "session_required",
        },
        replace: true,
      })
    }
    return result.session
  },
)

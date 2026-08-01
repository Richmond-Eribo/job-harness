// Typed API client for the Worker's /api/* endpoints — CROSS-ORIGIN.
//
// The frontend is a standalone app on a separate origin from the API worker.
// All calls go to `${API_URL}/api${path}` with credentials:"include" so the
// SameSite=None session cookie (set by Better Auth on the API origin) is
// attached cross-origin. The API worker echoes our origin in
// Access-Control-Allow-Origin + sets Access-Control-Allow-Credentials: true.
//
// 401 → the session expired; the router guards redirect to /login.
// 428 → onboarding incomplete; the guards redirect to /onboarding.
import { API_URL } from "./auth"

export class ApiError extends Error {
  status: number
  /**
   * The full JSON error body, when the response was JSON-shaped. Lets
   * callers read structured fields beyond `error` — e.g. the pre-flight gate
   * on POST /api/start returns 428 with `{error, missing: string[]}`, and
   * OverviewPage reads `err.body?.missing` to render a fixable checklist
   * instead of a bare toast.
   */
  body?: Record<string, unknown>
  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
    this.name = "ApiError"
  }
}

async function request<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = "GET", body, signal } = opts
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    credentials: "include", // send the cross-origin session cookie
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    // 401 + 428 are handled by the router guards (they watch navigation and
    // redirect), but still throw so callers can react.
    let msg = `Request failed (${res.status})`
    let data: Record<string, unknown> | undefined
    try {
      data = await res.json()
      msg = (data?.error as string | undefined) ?? msg
    } catch {
      // non-JSON error
    }
    throw new ApiError(msg, res.status, data)
  }

  // Some endpoints (e.g. CV download) return non-JSON; let callers handle that
  // separately. This helper is for JSON endpoints.
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) return res.json()
  return null as unknown as T
}

export const api = {
  get: <T = any>(path: string, signal?: AbortSignal) =>
    request<T>(path, { signal }),
  // L5: accept an AbortSignal on the mutating verbs too. Without this, a slow
  // /api/profile or /api/onboarding request lingers in-flight after the user
  // navigates away (and burns the deprecated `pending` state on the old page).
  post: <T = any>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body, signal }),
  put: <T = any>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "PUT", body, signal }),
  del: <T = any>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: "DELETE", signal }),
}

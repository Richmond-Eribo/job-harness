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
  constructor(message: string, status: number) {
    super(message)
    this.status = status
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
    try {
      const data = await res.json()
      msg = data?.error ?? msg
    } catch {
      // non-JSON error
    }
    throw new ApiError(msg, res.status)
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
  post: <T = any>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body }),
  put: <T = any>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body }),
  del: <T = any>(path: string) => request<T>(path, { method: "DELETE" }),
}

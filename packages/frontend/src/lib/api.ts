// Typed API client for the Worker's /api/* endpoints.
//
// Same-origin fetch — the session cookie authenticates automatically, so no
// Authorization header is needed (the legacy bearer token is gone). Every call
// goes through this helper so error handling is uniform.
//
// 401 → the session expired; the auth guard in the router will redirect to
// /login. 428 → onboarding incomplete; the guard redirects to /onboarding.

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
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    // 401 + 428 are handled by the router guards, but still throw so callers
    // can react. The guards watch for navigation-level redirects.
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

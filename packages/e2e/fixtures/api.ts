import { request, type APIRequestContext } from "@playwright/test"
import { E2E_API_URL, apiUrl } from "./env"

// Authenticated API request helper for the api-contract spec.
//
// Wraps Playwright's APIRequestContext so specs can call the REST surface
// directly (POST /api/jobs, GET /api/runs, etc.) with the session cookie
// attached, without going through the browser. Login happens via the real
// /api/auth/sign-in/email endpoint — same as the UI — so the cookie is genuine.

export interface LoginResult {
  context: APIRequestContext
  /** Disposes the underlying context (drops the cookie). */
  dispose: () => Promise<void>
}

/**
 * Logs in as `email`/`password` via Better Auth's sign-in endpoint and returns
 * a request context whose cookie jar holds the resulting session cookie.
 */
export async function loginAs(
  email: string,
  password: string,
): Promise<LoginResult> {
  const context = await request.newContext({ baseURL: E2E_API_URL })

  const res = await context.post("/api/auth/sign-in/email", {
    data: { email, password },
  })
  if (!res.ok()) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `loginAs(${email}) failed: ${res.status()} ${res.statusText()} ${body}`,
    )
  }
  return {
    context,
    dispose: async () => {
      await context.dispose()
    },
  }
}

export { apiUrl }

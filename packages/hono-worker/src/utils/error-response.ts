// =============================================================================
// errorResponse — one consistent JSON error shape for every route.
// =============================================================================
// PROBLEM
// Most routes in src/index.ts catch and return `{ error: e.message }, 500`,
// which leaks internal error text (stack-adjacent details, SQL fragments,
// third-party provider errors) straight to the client. A few routes (notably
// /api/onboarding) deliberately log server-side and return a generic message
// instead — the safer pattern, but applied inconsistently.
//
// This helper makes the safe pattern the ONE pattern: log the full error
// server-side (visible in `wrangler tail` / the dev console) and return a
// generic, safe message to the client, with an optional caller-supplied
// override for expected/user-facing error cases (e.g. "invalid id").
// =============================================================================
import type { Context } from "hono"

const GENERIC_MESSAGE = "Something went wrong. Please try again."

/**
 * Log `err` server-side with `label` context, then return a safe JSON error
 * response. Use for unexpected failures (caught exceptions) — never pass
 * `err.message` through to `publicMessage` unless you've deliberately
 * reviewed it as safe to expose.
 */
export function errorResponse(
  c: Context,
  label: string,
  err: unknown,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 = 500,
  publicMessage: string = GENERIC_MESSAGE,
) {
  console.error(
    `[api] ${label} THREW:`,
    err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err,
  )
  return c.json({ error: publicMessage }, status)
}

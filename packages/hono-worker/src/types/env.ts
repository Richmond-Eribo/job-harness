// =============================================================================
// Cloudflare Worker environment bindings
// =============================================================================
// Type-only imports keep the namespace generics strongly typed without a
// runtime circular dependency (the agent files import types from here).
import type {
  Harness,
  JobApplicationAgent,
} from "../agents"
import type { BrowserAgent, BrowserRelay } from "../agents/browser-relay"

// The RateLimiter DO is built in Stage 5. Typed by a forward import so this
// file compiles in Stages 1–4 before the class exists; the class lands in
// src/agents/rate-limiter.ts.
import type { RateLimiter } from "../agents/rate-limiter"

/**
 * Cloudflare Worker environment bindings.
 * Populated from wrangler.jsonc and secrets.
 */
export interface Env {
  // Durable Object namespaces — typed with their DO class so RPC method calls
  // (e.g. `await harness.start()`) are checked by the compiler.
  //
  // Multi-tenant: every agent DO below is resolved BY USER ID (the session
  // user), not a shared name — so each user gets an isolated brain/pipeline/
  // browser. The userId threads through the whole delegation chain.
  HARNESS: DurableObjectNamespace<Harness>
  JOB_AGENT: DurableObjectNamespace<JobApplicationAgent>

  // Browser capability (login-walled job sites). The relay DO bridges agent
  // CDP commands to either the user's real Chrome (via the extension relay)
  // or the managed headless Chromium (paid plan). The agent DO runs the
  // observe/act/extract LLM loop.
  BROWSER_RELAY: DurableObjectNamespace<BrowserRelay>
  BROWSER_AGENT: DurableObjectNamespace<BrowserAgent>

  // Global rate limiter — a SINGLE instance guards the shared LLM_API_KEY
  // across all users and enforces the per-user active-run limit. Always
  // addressed by a fixed name ("global"), never per-user.
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>

  // D1 — global auth/user directory (Better Auth tables). The single source
  // of truth for which users exist; the cron queries it to wake each user's
  // harness. Also holds the onboarding-complete flag.
  DB: D1Database

  // R2 — CV/résumé file storage, keyed by userId. The JobApplicationAgent DO
  // stores only a pointer {r2Key, filename, contentType}; the bytes live here.
  CV_BUCKET: R2Bucket

  // Managed headless browser binding (@cloudflare/playwright). Optional — only
  // present on the paid Workers plan. When absent, the relay targets the
  // extension (live) target only. Typed as a bare Fetcher so tsc doesn't choke
  // when the binding is missing in local dev.
  BROWSER?: Fetcher

  // Workers AI binding. Optional in v1 (the harness still calls the BYOK model
  // via the AI SDK); becomes the default for v2 when we drop the LLM_API_KEY
  // dependency and route through env.AI instead. Typed loosely so tsc doesn't
  // choke if the binding is absent during local dev.
  AI?: Ai

  // Secrets only — model identity + provider + generation params live in
  // src/config/llm-config.json (tunable, version-controlled). Env keeps the API key
  // plus runtime knobs that DON'T make sense in a static config (DO tokens).
  LLM_API_KEY: string
  MAX_STEPS: string

  // --- Auth (multi-tenant) ---
  // Better Auth secret — signs/verifies session cookies and extension tokens.
  AUTH_SECRET: string
  // Dedicated secret for extension WS tokens — INDEPENDENT of AUTH_SECRET so a
  // leaked extension token can be rotated without invalidating every web
  // session. Defaults to AUTH_SECRET for back-compat in deployments that
  // haven't set it yet (see extension-token.ts).
  EXTENSION_TOKEN_SECRET?: string
  // Resend API key for magic-link delivery. When empty, magic links are logged
  // to the console + surfaced via a dev-only response header (no email sent).
  RESEND_API_KEY?: string
  // E2E-only: when "1", verification OTPs are the deterministic "999999" so
  // the Playwright suite can complete signup without reading email. Set ONLY
  // in local .dev.vars — never in production. (See auth.ts generateOTP.)
  E2E_OTP_BYPASS?: string
  // Public base URL of the API deployment (e.g. https://api.example.com). Used
  // by Better Auth to build absolute callback URLs and as a trusted CORS origin.
  BETTER_AUTH_URL?: string
  // PROD only: parent domain (WITH leading dot, e.g. ".richmonderibo.dev") the
  // session cookie is scoped to, so the browser sends it to BOTH the web and
  // api subdomains — the frontend's server-side session forwarding depends on
  // it (see auth.ts defaultCookieAttributes). Ignored on localhost/127.0.0.1.
  COOKIE_DOMAIN?: string

  // Public base URL of the STANDALONE frontend (TanStack Start), e.g.
  // https://app.example.com (prod) or http://localhost:3000 (dev). Added to
  // Better Auth's trustedOrigins and to the CORS allowlist so the separate-origin
  // SPA can call /api/* with credentials (the session cookie).
  FRONTEND_URL?: string

  // Explicit local-dev override for the cookie/baseURL gates in auth.ts.
  // "true" forces dev cookie behavior (Lax, no Secure/Domain), "false" forces
  // prod behavior — wins over the hostname auto-detection. Wrangler delivers
  // vars as STRINGS, so auth.ts accepts "true"/"1" and "false"/"0" as well as
  // real booleans. Leave unset/false in any deployed environment.
  IS_LOCAL_DEV?: boolean | string

  // v2 non-secret knobs (sourced from wrangler.jsonc vars). Trace capture
  // toggle — "1" = on (default); any other value = off. Detailed cap values
  // (maxReasoningChars etc.) live in src/config/observability-config.json.
  CAPTURE_TRACE?: string

  // Forward-looking sendmail (Phase 2) — kept on Env so the sendmail tool can
  // read them at runtime without a redeploy when populated.
  MAIL_FROM?: string
  MAIL_ALLOWLIST?: string
}

// =============================================================================
// Worker Entry Point — pure REST API + WebSocket relay + scheduled watchdog
// =============================================================================
// This worker is the BACKEND. It serves NO HTML — the UI is a standalone
// TanStack Start app on a separate origin that calls these endpoints over CORS
// (see packages/frontend). HTTP surface:
//   /api/auth/*  → Better Auth (sign-up/in/out, OTP, session)
//   /api/*       → JSON REST API (CORS + session-cookie auth via requireAuth)
//   /browser/relay → WebSocket upgrade routed to the user's BROWSER_RELAY DO
//
// scheduled() is the cron watchdog that self-heals each user's Harness.
//
// v1 (Cloudflare FREE plan): Durable Objects + cron only — NO container/sandbox.
// =============================================================================

import { Hono } from "hono"
import type { Context } from "hono"
import { cors } from "hono/cors"
import { secureHeaders } from "hono/secure-headers"

import { getAgentByName } from "agents"
import type { Env } from "./types"
import type { AppEnv } from "./types/app-env"
import { Harness } from "./agents"

import { getAuth } from "./auth/session"
import { requireAuth } from "./auth/require-auth"
import { originCheck } from "./middleware/origin-check"
import {
  issueExtensionTokenRoute,
  userIdFromRelayRequest,
} from "./auth/extension-token"
import {
  createPairingCodeRoute,
  redeemPairingCodeRoute,
  refreshAccessTokenRoute,
  revokeAllRefreshTokensRoute,
} from "./auth/extension-pairing"
import { exportAccountRoute, deleteAccountRoute } from "./auth/account-routes"
import { getAgents, getHarnessForUser } from "./utils/get-agents"
import { getRateLimiter } from "./utils/get-agents"
import { errorResponse } from "./utils/error-response"
import { JOB_STATUSES } from "./agents"
import type { JobStatus } from "./types"
import { extractCvText } from "./utils/cv-text"
import {
  readJsonBody,
  numericParam,
  numericQuery,
  sanitizeFilename,
  browserProbeSchema,
  configUpdateSchema,
  CONFIG_ALLOWED_KEYS,
  followUpCreateSchema,
  followUpUpdateSchema,
  goalPutSchema,
  jobCreateSchema,
  jobSourceCreateSchema,
  jobSourceUpdateSchema,
  jobStatusSchema,
  jobUpdateSchema,
  memoryPutSchema,
  onboardingSchema,
  planAdvanceSchema,
  profilePatchSchema,
  scheduleCreateSchema,
  scheduleToggleSchema,
  startRunSchema,
} from "./utils/validation"
import browserConfig from "./config/browser-config.json"

// Re-export all Durable Object classes (required by Cloudflare)
export {
  Harness,
  JobApplicationAgent,
  BrowserRelay,
  BrowserAgent,
  RateLimiter,
} from "./agents"
// =============================================================================
// Hono app
// =============================================================================

// Sensible starter job source offered during onboarding (subject to the
// user opting in via `seedDefaultJobSources: true` — the checkbox is NOT
// pre-checked). Geography-neutral by design: seeding a region-specific board
// (e.g. a UK-only site) would skew every user's discovery toward that region
// regardless of their target locations. HN Who Is Hiring is public and
// login-free — deliberately NOT login-walled sites like LinkedIn/Indeed,
// since those require the extension to be paired first. A user with no
// sources configured sees a "Needed" pre-flight item on the dashboard. The
// seed is browse-only (no searchUrlTemplate) — the agent loads the base page
// and navigates via fetch_page. searchUrlTemplate is fully optional across
// the system (see src/agents/job-agent.ts).
const DEFAULT_JOB_SOURCES = [
  {
    name: "HN Who Is Hiring",
    baseUrl: "https://news.ycombinator.com",
    notes:
      "Default seeded source — Hacker News Who Is Hiring thread navigation.",
  },
]

const app = new Hono<AppEnv>()

// ── Health check — unauthenticated liveness probe for uptime monitoring. ──
// Deliberately mounted BEFORE CORS/auth middleware: an uptime monitor hitting
// this from an arbitrary network location shouldn't need CORS headers or a
// session. Returns 200 + a timestamp only — no user data, no DO/D1 round trip
// (a true liveness probe should never depend on the things it's monitoring).
app.get("/healthz", c => c.json({ ok: true, ts: new Date().toISOString() }))

// CORS on everything (preflight handled automatically by the middleware).
//
// The frontend is a STANDALONE app on a separate origin, so we can't use the
// wildcard "*" — browsers refuse to send credentials (the session cookie) when
// Access-Control-Allow-Origin is the literal "*" AND credentials are involved.
// Instead we echo the request Origin back iff it's in the allowlist (the
// frontend origin + the API origin itself). `credentials: true` sets
// Access-Control-Allow-Credentials so the cookie rides along cross-origin.
//
// P3-5/M1: `Set-Cookie` was previously listed in exposeHeaders, but it is a
// FORBIDDEN response-header name per the Fetch spec — browsers strip it from
// JS-readable headers regardless of Access-Control-Expose-Headers, so it was
// dead code. Removed.
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = new Set(
        [c.env.FRONTEND_URL, c.env.BETTER_AUTH_URL].filter(
          (o): o is string => typeof o === "string" && o.length > 0,
        ),
      )
      return origin && allowed.has(origin) ? origin : null
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
)

// ── Security headers (audit M8) ───────────────────────────────────────────
// Baseline hardening on every response: nosniff, SAMEORIGIN framing,
// referrer policy. No CSP here — this worker serves JSON only.
app.use("*", secureHeaders())

// ── CSRF origin-check on mutating routes (audit H3) ───────────────────────
// Must run AFTER cors (preflight OPTIONS is answered by the cors middleware
// and never reaches this) and BEFORE any mutating handler. See
// src/middleware/origin-check.ts for the exemption list.
app.use("*", originCheck)

// ── Better Auth handler ──────────────────────────────────────────────────
// Better Auth's handler owns the full request/response for its routes
// (sign-in, callback, session, sign-out, etc.). Mounted before requireAuth so
// the auth endpoints are reachable without a session. The instance is built
// per-request from env so baseURL resolves to the real request host.
//
// Better Auth's internal router (better-call) swallows unhandled errors into
// empty-body 500s, which are hard to diagnose. We wrap the handler so any 5xx
// is logged with the route for visibility in `wrangler tail` / the dev console.
//
// P2-4/H5: changed from `app.on(["GET", "POST"], "/api/auth/*", ...)` to
// `app.all(...)`. The previous filter only allowed GET/POST through to Better
// Auth — any PUT/DELETE/PATCH the email-OTP plugin (or future plugins) emit
// would fall through to Hono's 404 instead of Better Auth's error response,
// confusing clients that hit them.
app.all("/api/auth/*", async c => {
  const auth = getAuth(c)
  let res: Response
  try {
    res = await auth.handler(c.req.raw)
  } catch (err) {
    // Better Auth's handler should never throw (better-call wraps errors into
    // Responses), but if it does we log the real error here.
    console.error(
      `[auth] ${c.req.method} ${c.req.path} THREW:`,
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
    throw err
  }
  if (res.status >= 500) {
    // Clone + read the body so we can see Better Auth's error message (it's
    // usually an empty body, but when it isn't, the message is the diagnosis).
    const cloned = res.clone()
    const body = await cloned.text().catch(() => "<unreadable>")
    console.error(
      `[auth] ${c.req.method} ${c.req.path} → ${res.status}`,
      body ? `body=${body}` : "(empty body)",
    )
  }
  return res
})

// ── Session-cookie auth on everything ────────────────────────────────────
// Replaces the legacy shared bearer token. requireAuth reads the Better Auth
// session cookie, redirects HTML requests to /login (or 401s JSON), and on
// success sets c.var.session + c.var.userId. Exempt paths: /api/auth/*,
// /login, /signup, static assets, /browser/relay (auth'd via extension token).
app.use("*", requireAuth)

// ── Onboarding completion endpoint ───────────────────────────────────────
// A user who hasn't completed profile + CV setup is redirected to /onboarding
// by the frontend (the gate lives client-side now). This endpoint writes the
// profile fields + marks onboarding_complete = 1 in D1.

app.post("/api/onboarding", async c => {
  const userId = c.var.userId
  const parsed = await readJsonBody(c, onboardingSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  // Persist the profile fields to the user's JobApplicationAgent. The schema
  // allows ONLY known profile fields, each capped at 2000 chars (audit
  // M11 — previously unbounded strings went straight into the kv table and,
  // via prompt interpolation, into the system prompt).
  const { jobAgent } = await getAgents(c.env, userId)
  const profilePatch: Record<string, string> = {}
  for (const k of Object.keys(body) as (keyof typeof body)[]) {
    const v = body[k]
    if (typeof v === "string") profilePatch[k] = v
  }
  // Keep the D1 `name` column (the session display name) in sync with
  // firstName/lastName so the app shell shows the right thing without an
  // extra fetch.
  if (profilePatch.firstName || profilePatch.lastName) {
    profilePatch.fullName = [profilePatch.firstName, profilePatch.lastName]
      .filter(Boolean)
      .join(" ")
  }
  if (Object.keys(profilePatch).length > 0) {
    await jobAgent.setProfile(profilePatch)
  }

  // Optional: seed a couple of sensible default job sources so a brand-new
  // user doesn't land on the dashboard with zero configured sites (which
  // would make their first run a guaranteed no-op). Only inserts if the user
  // has NO sources yet AND explicitly opted in via `seedDefaultJobSources:
  // true` in the request body — never silently override an operator's
  // existing configuration. The two defaults are well-known public boards
  // that don't require login (so they work even before the extension is
  // paired); the user can edit/remove them from the Jobs → Sources UI.
  if (body?.seedDefaultJobSources) {
    try {
      const existing = await jobAgent.listJobSources()
      if (existing.length === 0) {
        for (const src of DEFAULT_JOB_SOURCES) {
          await jobAgent.addJobSource(src)
        }
      }
    } catch (e) {
      // Non-fatal — onboarding still succeeds; the user just won't have the
      // defaults and will see the pre-flight "add a job source" checklist
      // item on the dashboard instead.
      console.warn(
        `[api] POST /api/onboarding — failed to seed default job sources for ${userId}:`,
        e instanceof Error ? e.message : e,
      )
    }
  }

  // Mark onboarding complete in D1. The user can edit their profile later via
  // PUT /api/profile; this flag just unlocks the rest of the app.
  // Columns are camelCase to match migrations/0002_camelcase.sql (Better Auth
  // 1.6.x queries camelCase at runtime).
  //
  // NOTE (H3/M22): for fresh signups this flag is ALREADY flipped by the
  // `databaseHooks.user.update.after` hook on email verification, so this
  // write is a no-op (idempotent). It is intentionally kept for the case
  // where a user lands on /onboarding with `onboardingComplete=false` for any
  // other reason (legacy account, manual DB edit, hook failure mode).
  try {
    await c.env.DB.prepare(
      `UPDATE "user" SET onboardingComplete = 1, updatedAt = ? WHERE id = ?`,
    )
      .bind(Date.now(), userId)
      .run()
  } catch (error: any) {
    // P3-5/M17: log the full error server-side (D1 errors may contain column /
    // constraint names an operator needs to triage), return a generic 500 to
    // the client. The previous response leaked `error.message` straight to
    // the browser, which is a minor information disclosure.
    console.error(
      `[api] POST /api/onboarding — failed to mark onboarding for user ${userId}:`,
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : error,
    )
    return c.json(
      { error: "Failed to complete onboarding. Please try again." },
      500,
    )
  }

  return c.json({ message: "Onboarding complete", redirect: "/dashboard" })
})

// =============================================================================
// Status & Control
// =============================================================================
// Browser capability — relay WebSocket upgrade + status/control API.
// =============================================================================
// The Chrome extension connects its OUTBOUND WebSocket to /browser/relay
// (the Worker can't reach a browser behind NAT; the browser reaches us). That
// WS is what lets the agent drive the user's real, logged-in Chrome for
// login-walled job sites. See docs/browser-cdp-guide.md.

app.all("/browser/relay", async c => {
  // The extension can't send a session cookie on a WS upgrade, so the relay
  // identifies the user via a signed extension token. The dashboard mints the
  // token against the session user (POST /api/browser/extension-token); the
  // extension stores it and presents it back.
  //
  // P1-6 — two delivery channels (preferred first, legacy second):
  //   1. The `Sec-WebSocket-Protocol` header: `ja-ext-token.<jwt>`. The token
  //      never appears in the URL so it can't leak via history/logs/referrer.
  //   2. The legacy `?token=<jwt>` query param: still accepted for existing
  //      extension installs that haven't upgraded yet.
  const url = new URL(c.req.url)
  const userId = await userIdFromRelayRequest(
    url,
    // P1-6/H2: sign with EXTENSION_TOKEN_SECRET if present (independent
    // rotation), else fall back to AUTH_SECRET for back-compat.
    c.env.EXTENSION_TOKEN_SECRET && c.env.EXTENSION_TOKEN_SECRET.length > 0
      ? c.env.EXTENSION_TOKEN_SECRET
      : c.env.AUTH_SECRET,
    c.req.raw.headers,
  )
  if (!userId) {
    // Visible in `wrangler tail`. The extension's silent reconnect loop hides
    // this by default — surface the rejection so operators don't blame pairing
    // when the real cause is a clock-skew rejection or a secret mismatch
    // (mint ran on AUTH_SECRET, verify runs on EXTENSION_TOKEN_SECRET).
    console.warn(
      `[/browser/relay] 401 — token missing/invalid. ` +
        `protoHdr=${c.req.raw.headers.get("sec-websocket-protocol") ? "present" : "absent"}`,
    )
    return c.json({ error: "Missing or invalid extension token" }, 401)
  }
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, userId)
  return relay.fetch(c.req.raw)
})

// Mint an extension token for the session user (the dashboard surfaces it for
// the extension to copy/store). Session-gated by requireAuth.
//
// P2-5/H4: per-user rate limit. Without it, an attacker who steals a session
// cookie can mint an unlimited number of long-lived extension tokens that
// outlive the (now much shorter, 1h) session. Reuse the existing global
// RateLimiter DO with a dedicated key — limit to 5 mints per hour per user,
// which is far above any legitimate use (the dashboard re-mints on each panel
// open, and the panel is typically opened once per browser session).
app.post("/api/browser/extension-token", async c => {
  const userId = c.var.userId
  const rateLimiter = await getRateLimiter(c.env)
  const windowSeconds = 60 * 60 // 1h
  const limit = 5
  const { count } = await rateLimiter.check({
    key: "extension-token",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json(
      {
        error: "Too many extension tokens requested. Please try again later.",
      },
      429,
    )
  }
  await rateLimiter.consume({
    key: "extension-token",
    userId,
    windowSeconds,
  })
  return issueExtensionTokenRoute(c)
})

// ── Extension pairing (replaces manual token copy/paste) ───────────────────
// See src/auth/extension-pairing.ts for the full flow rationale. Summary:
//   1. POST /api/browser/pair          (session)    → {code, expiresIn}
//   2. POST /api/browser/pair/redeem   (NO session)  → {refreshToken, accessToken}
//   3. POST /api/browser/refresh       (NO session)  → {accessToken}
//   4. POST /api/browser/unpair        (session)     → revoke all refresh tokens
//
// (2) and (3) are deliberately NOT session-gated — the extension has no way
// to present a session cookie on these calls, and the code/refresh-token
// itself IS the credential (same trust model as a password-reset token).
app.post("/api/browser/pair", async c => {
  const userId = c.var.userId
  const rateLimiter = await getRateLimiter(c.env)
  // Reuses the existing extension-token rate-limit bucket shape: 5 pairing
  // attempts per hour is plenty for legitimate use (one per new device) and
  // bounds a stolen-session-cookie attacker's ability to mint codes.
  const windowSeconds = 60 * 60
  const limit = 5
  const { count } = await rateLimiter.check({
    key: "extension-pair",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json(
      { error: "Too many pairing attempts. Please try again later." },
      429,
    )
  }
  await rateLimiter.consume({ key: "extension-pair", userId, windowSeconds })
  try {
    return await createPairingCodeRoute(c)
  } catch (e) {
    return errorResponse(c, "POST /api/browser/pair", e)
  }
})

/** IP-scoped rate limit for the UNAUTHENTICATED extension endpoints (pair
 *  redeem + token refresh — no session exists for either). The DO rate
 *  limiter keys on an arbitrary string, so the caller's IP is the bucket
 *  key. Returns a 429 Response when over the limit, null when allowed. */
async function ipRateLimit(
  c: Context<AppEnv>,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown"
  const rateLimiter = await getRateLimiter(c.env)
  const { count } = await rateLimiter.check({ key, userId: ip, windowSeconds })
  if (count >= limit) {
    return c.json({ error: "Too many attempts. Please try again later." }, 429)
  }
  await rateLimiter.consume({ key, userId: ip, windowSeconds })
  return null
}

app.post("/api/browser/pair/redeem", async c => {
  // IP-scoped rate limit (no session/userId available pre-redeem) — bounds
  // brute-forcing the 6-char code space.
  const limited = await ipRateLimit(c, "extension-redeem", 20, 60 * 10)
  if (limited) return limited
  try {
    return await redeemPairingCodeRoute(c)
  } catch (e) {
    return errorResponse(c, "POST /api/browser/pair/redeem", e)
  }
})

app.post("/api/browser/refresh", async c => {
  // Prior L8: unauthenticated endpoint hammering D1 token-hash lookups.
  // The token itself is a 256-bit secret so this bounds abuse COST, not a
  // brute-force risk — same IP limit shape as redeem.
  const limited = await ipRateLimit(c, "extension-refresh", 20, 60 * 10)
  if (limited) return limited
  try {
    return await refreshAccessTokenRoute(c)
  } catch (e) {
    return errorResponse(c, "POST /api/browser/refresh", e)
  }
})

app.post("/api/browser/unpair", async c => {
  try {
    return await revokeAllRefreshTokensRoute(c)
  } catch (e) {
    return errorResponse(c, "POST /api/browser/unpair", e)
  }
})

app.get("/api/browser/status", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, c.var.userId)
  const snapshot = await relay.statusSnapshot()
  // Distribution info for the dashboard's ConnectBrowserCard Install step
  // (unpacked walkthrough vs Chrome Web Store link). Config-driven so a
  // deployment that publishes to the store just edits browser-config.json.
  const dist = (browserConfig as any).distribution ?? {}
  return c.json({
    ...snapshot,
    distribution: {
      mode: dist.mode === "store" ? "store" : "unpacked",
      storeUrl: typeof dist.storeUrl === "string" ? dist.storeUrl : undefined,
      guideUrl: typeof dist.guideUrl === "string" ? dist.guideUrl : undefined,
    },
  })
})

app.post("/api/browser/disconnect", async c => {
  const relay: any = await getAgentByName(c.env.BROWSER_RELAY, c.var.userId)
  return c.json({ disconnected: relay.disconnectLive() })
})

// Manual test harness — navigate + observe a URL through the connected browser
// and return the raw result. Backs the Browser Test panel on Settings. Lets the
// operator verify the whole chain (relay → extension → Chrome → CDP) without a
// full agent run. No LLM call, so it's free to run repeatedly — but it DOES
// drive a real browser tab, so still worth a generous rate limit to prevent a
// runaway UI loop or scripted abuse from hammering the relay/extension.
app.post("/api/browser/probe", async c => {
  // AUDIT H6: url is schema-validated — absolute http(s) only. Previously a
  // truthiness check let ANY string through to CDP Page.navigate, including
  // javascript:/data: URLs, in the user's real Chrome.
  const parsed = await readJsonBody(c, browserProbeSchema)
  if (!parsed.ok) return parsed.response
  const userId = c.var.userId
  const rateLimiter = await getRateLimiter(c.env)
  const windowSeconds = 60
  const limit = 20
  const { count } = await rateLimiter.check({
    key: "browser-probe",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json({ error: "Too many probe requests. Please slow down." }, 429)
  }
  await rateLimiter.consume({ key: "browser-probe", userId, windowSeconds })
  const agent: any = await getAgentByName(c.env.BROWSER_AGENT, c.var.userId)
  try {
    return c.json(await agent.probe(parsed.data.url))
  } catch (e) {
    return errorResponse(c, "POST /api/browser/probe", e)
  }
})

// =============================================================================

app.get("/api/status", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getFullStatus())
})

// Pre-flight requirements for a useful run. This does NOT block starting the
// agent (a run with zero job sources still "works" — it just can't discover
// anything) — it's advisory so the UI can show a fixable checklist instead of
// the agent silently doing nothing. Kept as a named export so a future
// `usePreflight` hook / test can reuse the exact same logic without
// duplicating field lists.
async function computePreflightGaps(
  env: Parameters<typeof getAgents>[0],
  userId: string,
): Promise<string[]> {
  const missing: string[] = []
  const { jobAgent } = await getAgents(env, userId)
  const [profile, sources] = await Promise.all([
    jobAgent.getProfile(),
    jobAgent.listJobSources(),
  ])
  if (!profile.cvR2Key) missing.push("cv")
  if (sources.filter(s => s.enabled).length === 0) missing.push("job-sources")
  const relay: any = await getAgentByName(env.BROWSER_RELAY, userId)
  const status = await relay.statusSnapshot()
  if (status.target === "none") missing.push("browser")
  return missing
}

// GET-only check so the UI can show the checklist BEFORE the user clicks
// Start (e.g. the Overview page's pre-flight banner) without side effects.
app.get("/api/start/preflight", async c => {
  try {
    const missing = await computePreflightGaps(c.env, c.var.userId)
    return c.json({ ready: missing.length === 0, missing })
  } catch (e) {
    return errorResponse(c, "GET /api/start/preflight", e)
  }
})

app.post("/api/start", async c => {
  // AUDIT H1/H2: goal is the only input; it is now schema-validated and
  // length-capped (previously an unbounded string interpolated verbatim into
  // the system prompt).
  const parsed = await readJsonBody(c, startRunSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  // NOTE: POST /api/start NO LONGER has a 428 pre-flight gate. The gate
  // was designed to prevent silent no-op runs, but in practice it confused
  // users who expected the button to just work. Now:
  //   • /api/start/preflight is advisory (surfaces missing items in the UI).
  //   • The frontend only blocks via a modal when `job-sources` is missing
  //     (the one case where the run genuinely can't do anything); CV and
  //     browser warnings are shown as toasts but the run starts anyway.
  //   • {force: true} is kept in the request signature for back-compat but
  //     is now a no-op — the server never blocks.
  void body?.force
  const { harness } = await getAgents(c.env, c.var.userId)
  // Pass the session userId so the harness persists it + threads it through
  // buildAgentTools → every delegating tool resolves sub-agents by this user.
  // applyJobId (from "Apply with agent") makes the harness move that job to
  // "applied" when the run finishes successfully.
  return c.json({
    message: await harness.start(body.goal, c.var.userId, body.applyJobId),
  })
})

app.post("/api/stop", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.stop() })
})

app.post("/api/pause", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.pause() })
})

app.post("/api/resume", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.resume() })
})

// =============================================================================
// Config
// =============================================================================

app.get("/api/config", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getConfig())
})

app.put("/api/config", async c => {
  // AUDIT C2/H5: the body is now schema-validated AND key-allowlisted.
  // Previously ANY keys were persisted into the harness config table —
  // including llmProvider/customProviderUrl, which made getModel() send the
  // SHARED LLM_API_KEY to an attacker-chosen baseURL. Model/provider config
  // is operator-managed (src/config/llm-config.json); users may only tune
  // goal / maxSteps (1..1000) / tokenBudget (0..50M).
  const parsed = await readJsonBody(c, configUpdateSchema, {
    allowedKeys: CONFIG_ALLOWED_KEYS,
  })
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.updateConfig(parsed.data) })
})

// =============================================================================
// Schedules
// =============================================================================

app.get("/api/schedules", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.listAppSchedules())
})

app.post("/api/schedules", async c => {
  const parsed = await readJsonBody(c, scheduleCreateSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json({
      message: await harness.addSchedule(parsed.data.cron, parsed.data.focus ?? "all"),
    })
  } catch (e) {
    // addSchedule throws on invalid cron (cron-parser) — a client-fixable
    // input error, surfaced as a clean 400 instead of a 500.
    return errorResponse(
      c,
      "POST /api/schedules",
      e,
      400,
      e instanceof Error ? e.message : "Invalid schedule",
    )
  }
})

app.delete("/api/schedules/:id", async c => {
  const id = numericParam(c, "id")
  if (!id.ok) return id.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.removeSchedule(id.value) })
})

app.put("/api/schedules/:id/toggle", async c => {
  const id = numericParam(c, "id")
  if (!id.ok) return id.response
  const parsed = await readJsonBody(c, scheduleToggleSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.toggleSchedule(id.value, parsed.data.enabled),
  })
})

// =============================================================================
// Logs & Summaries
// =============================================================================

app.get("/api/log", async c => {
  const limit = numericQuery(c, "limit", 50, 1, 500)
  if (!limit.ok) return limit.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getLog(limit.value))
  } catch (e) {
    return errorResponse(c, "GET /api/log", e)
  }
})

app.get("/api/summaries", async c => {
  const limit = numericQuery(c, "limit", 10, 1, 100)
  if (!limit.ok) return limit.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getDailySummaries(limit.value))
  } catch (e) {
    return errorResponse(c, "GET /api/summaries", e)
  }
})

// =============================================================================
// Trace — model thinking + per-step usage breakdown
// =============================================================================
// Backs the Trace tab. listRuns() populates the run picker; getTrace(runId)
// returns the ordered step list with reasoning, text, usage, duration.
// =============================================================================

app.get("/api/runs", async c => {
  const limit = numericQuery(c, "limit", 20, 1, 200)
  if (!limit.ok) return limit.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.listRuns(limit.value))
  } catch (e) {
    return errorResponse(c, "GET /api/runs", e)
  }
})

app.get("/api/run/:runId/trace", async c => {
  const runId = c.req.param("runId")
  if (!runId) return c.json({ error: "runId required" }, 400)
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getTrace(runId))
})

// =============================================================================
// Memory — the harness's remembered facts (the `context` table)
// =============================================================================
// These rows back the Memory tab. The harness already has read/write via the
// `remember` / `recall` tools the LLM calls; these routes expose the same
// rows to the dashboard for human inspection and editing.
// =============================================================================

app.get("/api/memory", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getAllMemory())
})

app.put("/api/memory", async c => {
  const parsed = await readJsonBody(c, memoryPutSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.setMemory(parsed.data.key, parsed.data.value ?? ""),
  })
})

app.delete("/api/memory/:key", async c => {
  // Malformed percent-encoding (a bare "%") makes decodeURIComponent THROW —
  // previously a 500 for what is a client error. Decode defensively → 400.
  let key: string
  try {
    key = decodeURIComponent(c.req.param("key"))
  } catch {
    return c.json({ error: "Invalid memory key encoding" }, 400)
  }
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.forgetMemory(key) })
})

// =============================================================================
// User memory — human-authored notes injected into every system prompt
// =============================================================================
// Distinct from /api/memory (the agent's own recalled facts). These are the
// operator's notes — higher authority than the agent's recall.
// =============================================================================

app.get("/api/user-memory", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json(await harness.getAllUserMemory())
})

app.put("/api/user-memory", async c => {
  const parsed = await readJsonBody(c, memoryPutSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await harness.setUserMemory(parsed.data.key, parsed.data.value ?? ""),
  })
})

app.delete("/api/user-memory/:key", async c => {
  let key: string
  try {
    key = decodeURIComponent(c.req.param("key"))
  } catch {
    return c.json({ error: "Invalid memory key encoding" }, 400)
  }
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.forgetUserMemory(key) })
})

// =============================================================================
// Goals — the prominent platform. Set/read the active goal.
// =============================================================================

app.get("/api/goal", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const status = await harness.getFullStatus()
  return c.json({ goal: status.goal })
})

app.put("/api/goal", async c => {
  const parsed = await readJsonBody(c, goalPutSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await harness.setGoal(parsed.data.goal) })
})

app.post("/api/goal/synthesize", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  const goal = await harness.synthesizeGoalFromCapabilities()
  return c.json({ goal })
})

// =============================================================================
// Plan — structured execution plan for the current/next run
// =============================================================================

app.get("/api/plan", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json({ plan: await harness.getPlan() })
  } catch (e) {
    return errorResponse(c, "GET /api/plan", e)
  }
})

app.post("/api/plan/advance", async c => {
  // AUDIT M6: status is now enum-checked (previously any string was persisted
  // into plan steps).
  const parsed = await readJsonBody(c, planAdvanceSchema)
  if (!parsed.ok) return parsed.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    const plan = await harness.advancePlan(
      parsed.data.stepId ?? null,
      parsed.data.status,
      parsed.data.result ?? null,
    )
    return c.json({ plan })
  } catch (e) {
    return errorResponse(c, "POST /api/plan/advance", e)
  }
})

// =============================================================================
// Trace events — append-only event log backing Traces + Logs pages
// =============================================================================
// getTraceEvents(runId) returns the ordered stream of events for a single run:
// run_start, system (full prompt), prompt, reasoning, text, tool_call,
// tool_result, step_end, run_end. This is what the TraceSheet renders.
//
// /api/runs/:runId/live is the SSE-ish long-poll endpoint: pass ?sinceSeq=N,
// get back events with seq > N. The dashboard polls every ~2s while a run is
// active to render the "what is the model working on right now" panel.
// =============================================================================

app.get("/api/runs/:runId/events", async c => {
  const runId = c.req.param("runId")
  const sinceSeq = numericQuery(c, "sinceSeq", 0, 0, 1_000_000_000)
  if (!sinceSeq.ok) return sinceSeq.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTraceEvents(runId, sinceSeq.value))
  } catch (e) {
    return errorResponse(c, "GET /api/runs/:runId/events", e)
  }
})

// Single run: metadata + ordered events in ONE payload. The transcript page
// hydrates from this (one round trip) instead of two separate calls. Events
// already carry the v2 columns (agent, toolCallId, parentId, parentLabel,
// cacheRead/Write, truncated) the transcript renderer needs.
app.get("/api/runs/:runId", async c => {
  const runId = c.req.param("runId")
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    const [run, events] = await Promise.all([
      harness.getRun(runId),
      harness.getTraceEvents(runId, 0, 2000),
    ])
    return c.json({ run, events })
  } catch (e) {
    return errorResponse(c, "GET /api/runs/:runId", e)
  }
})

// ── Debug endpoints — LOCAL DEV ONLY ────────────────────────────────────────
// Both were previously reachable by any authenticated user in every
// environment (session-gated only, same tier as production routes). They
// trigger a live model call / dump internal message state — useful for
// diagnosing provider-shape drift locally, but not something any signed-in
// user should be able to trigger against the shared LLM_API_KEY in prod.
// Gated behind IS_LOCAL_DEV (set in .dev.vars, unset in the deployed prod
// environment) so they simply 404 in production instead of needing a
// separate build flag.
app.use("/api/debug/*", async (c, next) => {
  // Env vars from .dev.vars/wrangler secrets always arrive as STRINGS at
  // runtime even though the type declares `boolean` (same caveat documented
  // in auth.ts's isLocalDev detection) — so a literal string "false" would be
  // truthy under a naive `if (!c.env.IS_LOCAL_DEV)` check. Parse explicitly.
  const raw = c.env.IS_LOCAL_DEV as unknown
  const isLocalDev = raw === true || raw === "true" || raw === "1"
  if (!isLocalDev) return c.notFound()
  return next()
})

// Model probe — sends a canned tiny request to the configured model and
// returns the RAW shapes (response.messages, full usage incl. cache +
// reasoning details, response.headers, providerMetadata, finishReason). The
// "learn what each model returns" lever: run this after switching providers
// to see exactly what the trace renderer will be working with.
app.get("/api/debug/model-probe", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    // Cast to any: probeModel's return type (with the model-info union) can
    // push Hono's c.json() type instantiation past its depth limit.
    return c.json((await harness.probeModel()) as any)
  } catch (e) {
    return errorResponse(c, "GET /api/debug/model-probe", e)
  }
})

// DEBUG: validate the current checkpoint's messages against the AI SDK v7
// ModelMessage[] schema. Returns the exact field that fails. Used to diagnose
// "messages do not match the ModelMessage[] schema" without guessing.
app.get("/api/debug/validate-messages", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json((await (harness as any).debugValidateMessages()) as any)
  } catch (e) {
    return errorResponse(c, "GET /api/debug/validate-messages", e)
  }
})

app.get("/api/trace-events", async c => {
  const limit = numericQuery(c, "limit", 200, 1, 1000)
  if (!limit.ok) return limit.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getRecentTraceEvents(limit.value))
  } catch (e) {
    return errorResponse(c, "GET /api/trace-events", e)
  }
})

// Token spend grouped by day — bars for the Overview chart.
app.get("/api/tokens-by-day", async c => {
  const days = numericQuery(c, "days", 14, 1, 90)
  if (!days.ok) return days.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTokensByDay(days.value))
  } catch (e) {
    return errorResponse(c, "GET /api/tokens-by-day", e)
  }
})

// Per-turn output token stats — drives the Overview "Output tokens / turn" card.
app.get("/api/turn-tokens", async c => {
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getTurnTokenStats())
  } catch (e) {
    return errorResponse(c, "GET /api/turn-tokens", e)
  }
})

// Notifications — recent operator-relevant happenings for the bell dropdown.
app.get("/api/notifications", async c => {
  const limit = numericQuery(c, "limit", 12, 1, 50)
  if (!limit.ok) return limit.response
  const { harness } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await harness.getRecentNotifications(limit.value))
  } catch (e) {
    return errorResponse(c, "GET /api/notifications", e)
  }
})

// Single job detail — listing + cover letters + follow-ups. Backs the Kanban
// card → Sheet drawer.
app.get("/api/jobs/:id", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  try {
    return c.json(await jobAgent.getJob(jobId.value))
  } catch (e) {
    return errorResponse(c, "GET /api/jobs/:id", e)
  }
})

// =============================================================================
// Job Pipeline
// =============================================================================

app.get("/api/pipeline", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getPipeline())
})

// =============================================================================
// Job sources — operator-configured job websites the agent is allowed to browse.
// CRUD routes backing the dashboard's "Sources" management UI. The agent's
// search tools read the same `job_sources` table at runtime to scope every
// fetch_page / search_site to an enabled source's origin.
// =============================================================================

app.get("/api/job-sources", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.listJobSources())
})

app.post("/api/job-sources", async c => {
  const parsed = await readJsonBody(c, jobSourceCreateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  try {
    const s = parsed.data
    return c.json(
      await jobAgent.addJobSource({
        name: s.name,
        baseUrl: s.baseUrl,
        searchUrlTemplate: s.searchUrlTemplate,
        notes: s.notes ?? undefined,
      }),
    )
  } catch (e) {
    // addJobSource throws descriptive TypeErrors for bad baseUrl/template —
    // client-fixable, so 400 (previously an RPC 500).
    return errorResponse(
      c,
      "POST /api/job-sources",
      e,
      400,
      e instanceof Error ? e.message : "Invalid job source",
    )
  }
})

app.put("/api/job-sources/:id", async c => {
  const id = numericParam(c, "id")
  if (!id.ok) return id.response
  const parsed = await readJsonBody(c, jobSourceUpdateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  try {
    return c.json({
      message: await jobAgent.updateJobSource(id.value, {
        ...parsed.data,
        notes: parsed.data.notes ?? undefined,
      }),
    })
  } catch (e) {
    return errorResponse(c, "PUT /api/job-sources/:id", e)
  }
})

app.delete("/api/job-sources/:id", async c => {
  const id = numericParam(c, "id")
  if (!id.ok) return id.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.removeJobSource(id.value) })
})

app.post("/api/jobs", async c => {
  const parsed = await readJsonBody(c, jobCreateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(
    await jobAgent.addJob({
      ...parsed.data,
      url: parsed.data.url ?? undefined,
    }),
  )
})

// Triggers a full LLM call — rate-limited per user so a scripted loop (or an
// impatient double-click) can't run up the shared LLM_API_KEY's bill/limit.
app.post("/api/jobs/:id/cover-letter", async c => {
  const jobId = Number(c.req.param("id"))
  if (!Number.isFinite(jobId)) return c.json({ error: "invalid id" }, 400)
  const userId = c.var.userId
  const rateLimiter = await getRateLimiter(c.env)
  const windowSeconds = 60
  const limit = 10
  const { count } = await rateLimiter.check({
    key: "cover-letter",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json(
      { error: "Too many cover-letter requests. Please slow down." },
      429,
    )
  }
  await rateLimiter.consume({ key: "cover-letter", userId, windowSeconds })
  const { jobAgent } = await getAgents(c.env, userId)
  try {
    return c.json(await jobAgent.generateCoverLetter({ jobId }))
  } catch (e) {
    return errorResponse(c, "POST /api/jobs/:id/cover-letter", e)
  }
})

app.get("/api/jobs/:id/cover-letters", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getCoverLettersForJob(jobId.value))
})

// Tailored CV generation — same LLM cost shape as cover letters, so the same
// per-user rate limit applies.
app.post("/api/jobs/:id/tailored-cv", async c => {
  const jobId = Number(c.req.param("id"))
  if (!Number.isFinite(jobId)) return c.json({ error: "invalid id" }, 400)
  const userId = c.var.userId
  const rateLimiter = await getRateLimiter(c.env)
  const windowSeconds = 60
  const limit = 10
  const { count } = await rateLimiter.check({
    key: "tailored-cv",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json(
      { error: "Too many tailored-CV requests. Please slow down." },
      429,
    )
  }
  await rateLimiter.consume({ key: "tailored-cv", userId, windowSeconds })
  const { jobAgent } = await getAgents(c.env, userId)
  try {
    return c.json(await jobAgent.generateTailoredCv({ jobId }))
  } catch (e: any) {
    // Missing cvText is a client-fixable state, not a server fault.
    if (String(e?.message ?? "").includes("No parsed CV text")) {
      return c.json({ error: e.message }, 422)
    }
    return errorResponse(c, "POST /api/jobs/:id/tailored-cv", e)
  }
})

app.get("/api/jobs/:id/tailored-cvs", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getTailoredCvsForJob(jobId.value))
})

app.put("/api/jobs/:id/status", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const parsed = await readJsonBody(c, jobStatusSchema)
  if (!parsed.ok) return parsed.response
  // Route-level enum guard (the DO re-validates) so a bad status is a clean
  // 400 rather than a 500 from a thrown RPC error.
  if (!(JOB_STATUSES as readonly string[]).includes(parsed.data.status)) {
    return c.json(
      {
        error: `Invalid status "${parsed.data.status}". Valid statuses: ${JOB_STATUSES.join(", ")}`,
      },
      400,
    )
  }
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.updateStatus({
      jobId: jobId.value,
      status: parsed.data.status as JobStatus,
      notes: parsed.data.notes,
    }),
  })
})

// Edit a listing's mutable fields (notes/priority) from the job detail view.
app.put("/api/jobs/:id", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const parsed = await readJsonBody(c, jobUpdateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.updateJob({
      jobId: jobId.value,
      notes: parsed.data.notes,
      priority: parsed.data.priority,
    }),
  })
})

app.delete("/api/jobs/:id", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.deleteJob({ jobId: jobId.value }) })
})

app.post("/api/jobs/:id/follow-up", async c => {
  const jobId = numericParam(c, "id")
  if (!jobId.ok) return jobId.response
  const parsed = await readJsonBody(c, followUpCreateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.addFollowUp({
      jobId: jobId.value,
      dueDate: parsed.data.dueDate,
      note: parsed.data.note,
    }),
  })
})

// =============================================================================
// Profile
// =============================================================================

app.get("/api/profile", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getProfile())
})

app.put("/api/profile", async c => {
  // AUDIT H4: the raw body was previously written key-by-key into the
  // user_profile kv table (mass assignment — cvR2Key and friends were
  // client-settable, and GET /api/profile/cv then fetched ANY R2 key it
  // pointed at). The schema allowlists exactly the editable profile fields;
  // everything else is dropped before it reaches the DO.
  const parsed = await readJsonBody(c, profilePatchSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  // Keep `fullName` in sync with firstName/lastName so any code reading the
  // legacy single-name field (and the session display name) stays correct
  // when the user edits their name on the profile page.
  if (typeof body.firstName === "string" || typeof body.lastName === "string") {
    const merged = { ...(await jobAgent.getProfile()), ...body }
    body.fullName = [merged.firstName, merged.lastName]
      .filter(Boolean)
      .join(" ")
  }
  return c.json({ message: await jobAgent.setProfile(body) })
})

// CV file upload — stores the bytes in R2 (keyed by userId), and writes only a
// metadata pointer {r2Key, filename, contentType} into the user's profile.
// The bytes never touch SQLite. Cap raised to 10 MB for real PDFs/DOCX.
app.post("/api/profile/cv", async c => {
  const userId = c.var.userId
  // Rate-limited: a 10 MB upload is cheap to script-spam and would otherwise
  // let a single user burn R2 write ops / storage unbounded.
  const rateLimiter = await getRateLimiter(c.env)
  const windowSeconds = 60 * 10
  const limit = 10
  const { count } = await rateLimiter.check({
    key: "cv-upload",
    userId,
    windowSeconds,
  })
  if (count >= limit) {
    return c.json(
      { error: "Too many CV uploads. Please try again later." },
      429,
    )
  }
  await rateLimiter.consume({ key: "cv-upload", userId, windowSeconds })
  const { jobAgent } = await getAgents(c.env, userId)
  // AUDIT L3: filename is sanitized (basename, control chars stripped, length
  // capped) before it is stored in R2 metadata + the profile and echoed back.
  const filename = sanitizeFilename(
    c.req.query("filename") ?? undefined,
    "cv",
  )
  const contentType = c.req.header("Content-Type") || "application/octet-stream"
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > 10 * 1024 * 1024) {
    return c.json({ error: "File too large (max 10 MB)" }, 413)
  }
  const r2Key = `cvs/${userId}/${crypto.randomUUID()}`
  await c.env.CV_BUCKET.put(r2Key, raw, {
    httpMetadata: { contentType },
  })
  // Parse the CV to text NOW (best-effort) — the tailoring LLM reads real
  // content, not an R2 pointer (PROJECT_PLAN §4.3). Failure is non-blocking:
  // cvText stays null and generation returns a clear error later.
  const cvText = await extractCvText(raw, contentType, filename)
  // Store the pointer (NOT the bytes) in the profile kv table.
  await jobAgent.setProfile({
    cv: JSON.stringify({ r2Key, filename, contentType }),
    cvFilename: filename,
    cvContentType: contentType,
    cvR2Key: r2Key,
    cvUploadedAt: new Date().toISOString(),
    cvText: cvText ?? "",
  })
  return c.json({
    message: `CV uploaded (${filename}, ${raw.byteLength} bytes)`,
    r2Key,
    filename,
    contentType,
    cvTextExtracted: cvText != null,
  })
})

// CV download — streams the file back from R2 (attachment). Lets the user
// retrieve their uploaded CV and lets operators verify uploads.
app.get("/api/profile/cv", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  const profile = await jobAgent.getProfile()
  if (!profile.cvR2Key) {
    return c.json({ error: "No CV uploaded" }, 404)
  }
  // AUDIT H4: never fetch an R2 key outside this user's own prefix. With the
  // profile allowlist this should be unreachable, but defense-in-depth in case
  // a future writer reintroduces client-settable keys.
  if (!profile.cvR2Key.startsWith(`cvs/${c.var.userId}/`)) {
    console.error(
      `[api] GET /api/profile/cv — profile.cvR2Key outside user prefix for ${c.var.userId}; refusing`,
    )
    return c.json({ error: "No CV uploaded" }, 404)
  }
  const obj = await c.env.CV_BUCKET.get(profile.cvR2Key)
  if (!obj) {
    return c.json({ error: "CV file not found in storage" }, 404)
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(profile.cvFilename ?? "cv")}"`,
  )
  return new Response(obj.body, { headers })
})

// =============================================================================
// Follow-ups
// =============================================================================

app.get("/api/follow-ups", async c => {
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json(await jobAgent.getDueFollowUps())
})

// Follow-up lifecycle — complete/edit a nudge (tick off after the recruiter
// replies, shift the due date) or remove it entirely. Backs the job detail
// view's Follow-ups tab.
app.put("/api/follow-ups/:id", async c => {
  const followUpId = numericParam(c, "id")
  if (!followUpId.ok) return followUpId.response
  const parsed = await readJsonBody(c, followUpUpdateSchema)
  if (!parsed.ok) return parsed.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({
    message: await jobAgent.updateFollowUp({
      followUpId: followUpId.value,
      completed: parsed.data.completed,
      dueDate: parsed.data.dueDate,
      note: parsed.data.note,
    }),
  })
})

app.delete("/api/follow-ups/:id", async c => {
  const followUpId = numericParam(c, "id")
  if (!followUpId.ok) return followUpId.response
  const { jobAgent } = await getAgents(c.env, c.var.userId)
  return c.json({ message: await jobAgent.deleteFollowUp({ followUpId: followUpId.value }) })
})

// =============================================================================
// Account — data export + delete.
// =============================================================================
// Closes the gap with LandingPage's "Export or delete everything from
// Settings whenever you want" marketing copy. See src/auth/account-routes.ts
// for the full design (which DOs are destroyed, what's in the export).
app.get("/api/account/export", async c => {
  try {
    return await exportAccountRoute(c)
  } catch (e) {
    return errorResponse(c, "GET /api/account/export", e)
  }
})

app.delete("/api/account", async c => {
  try {
    return await deleteAccountRoute(c)
  } catch (e) {
    return errorResponse(c, "DELETE /api/account", e)
  }
})

// =============================================================================
// Main Worker export
// =============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // AUDIT C1: the previous flow fell through to the agents-SDK router
    // (`routeAgentRequest`) whenever Hono returned 404. That router forwards
    // `/agents/{namespace}/{name}` — including WebSocket upgrades — straight
    // to `idFromName(name)` with NO auth callback, so ANY authenticated user
    // could reach ANY other user's Durable Objects (e.g. hijack a victim's
    // browser-relay: BrowserRelay.fetch accepts any WS upgrade). No client in
    // this repo uses /agents/* URLs (the extension connects via
    // /browser/relay; the dashboard uses /api/*), so the fallback is removed
    // outright — unknown paths now 404 like any other route.
    return app.fetch(request, env as any)
  },

  // Cron watchdog — multi-tenant with per-user staggering.
  //
  // Enumerates every user from D1 and wakes EACH user's harness. The harness
  // inspects its own state and decides internally whether a run is due (the
  // Managed Agents "wake(sessionId)" shape). Per-user try/catch so one failing
  // user's harness doesn't block the others.
  //
  // STAGGERING: wakes are spread across the 2-minute cron window using a
  // deterministic per-user offset (a hash of the userId % 120s → setTimeout).
  // This prevents N users from all firing their first LLM call in the same
  // tick, which would hammer the shared LLM_API_KEY's rate limit.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    let users: { id: string }[] = []
    try {
      const result = await env.DB.prepare("SELECT id FROM user").all<{
        id: string
      }>()
      users = result.results ?? []
    } catch (error: any) {
      console.error("[watchdog] failed to enumerate users:", error.message)
      return
    }

    const STAGGER_WINDOW_MS = 120_000 // the cron runs every 2 minutes
    for (const u of users) {
      // Deterministic offset: a simple string hash of the userId, modulo the
      // window. The same user always gets the same offset, so their wake time
      // is stable across ticks.
      const offset =
        Array.from(u.id).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0) %
        STAGGER_WINDOW_MS
      const absOffset = Math.abs(offset)
      setTimeout(() => {
        getHarnessForUser(env, u.id)
          .then(harness => harness.wake())
          .then(result => {
            if (result.ran) {
              console.log(`[watchdog] user ${u.id} wake → ${result.reason}`)
            }
          })
          .catch((error: any) => {
            // One user's failure must not stop the rest.
            console.error(
              `[watchdog] user ${u.id} wake error:`,
              error.message,
            )
          })
      }, absOffset)
    }
  },
}

// =============================================================================
// Better Auth instance — email/password + email-OTP verification on D1 + Resend.
// =============================================================================
// DESIGN
// Better Auth has first-class D1 support — its `database` option accepts a
// D1Database binding directly (it spins up a Kysely D1 dialect internally), so
// we DON'T need the drizzle adapter. The tables are created by the raw SQL
// migration migrations/0001_auth.sql; here we only declare the extra
// `onboardingComplete` user field so Better Auth reads/writes it correctly.
//
// The auth instance is created per-request from env (cheap) because Better Auth
// resolves `baseURL` at construction and we want it to reflect the actual
// request host in dev. It's mounted on Hono via app.on(["GET","POST"],
// "/api/auth/*", ...) in src/index.ts.
//
// AUTH MODEL
//   - Credentials: email + password (Scrypt-hashed, stored in the `account`
//     table's `password` column — already in the schema).
//   - Email verification: a 6-digit OTP code (Better Auth's `emailOTP` plugin)
//     delivered via Resend. The plugin mints the code, stores it HASHED in the
//     existing `verification` table, enforces 3 attempts + a 60s/3 rate limit,
//     and exposes /sign-up/email, /sign-in/email, /email-otp/send-verification-
//     otp, /email-otp/verify-email, etc. `overrideDefaultEmailVerification`
//     routes the standard verify-email flow through OTP.
//   - `requireEmailVerification` blocks sign-in until the code is confirmed, so
//     signup always goes: enter email+password → receive OTP → verify → in.
//
// Resend is called UNCONDITIONALLY (no dev-mode console fallback). If
// RESEND_API_KEY or MAIL_FROM is missing, sendOtpEmail throws loudly — see
// resend.ts. Verify your sending domain at resend.com/domains.
//
// OTP DELIVERY (server-driven):
//   The server sends the verification code at signUp.email time via the
//   top-level `hooks.after` below — the frontend does NOT call
//   send-verification-otp after signup. This makes "one signup request → at
//   most one OTP email" structural: double form submits, the legacy frontend
//   during a deploy window, and rapid Resend clicks all collapse onto a
//   30s send cooldown (see OTP_SEND_COOLDOWN_MS). The hook fires on BOTH
//   signup outcomes — fresh user AND the duplicate-email synthetic 200
//   (anti-enumeration) — because it reads the email off the endpoint's
//   response, which carries the requested address either way.
// =============================================================================
import { betterAuth } from "better-auth"
import { emailOTP } from "better-auth/plugins"
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api"
import { z } from "zod"
import type { Env } from "../types"
import { sendOtpEmail } from "./resend"

/**
 * The shape Better Auth returns for a session. We widen `user` with our extra
 * onboarding field so downstream code can read it without `any`.
 */
export interface AuthSession {
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
  session: {
    id: string
    token: string
    userId: string
    expiresAt: Date
  }
}

export type Auth = ReturnType<typeof createAuth>

// ─────────────────────────────────────────────────────────────────────────────
// Server-driven signup OTP — paths, cooldown, and response helpers.
// ─────────────────────────────────────────────────────────────────────────────
const SIGNUP_PATH = "/sign-up/email"
const SEND_OTP_PATH = "/email-otp/send-verification-otp"
/** Password-reset OTP minting paths (current + the deprecated alias). The
 *  implicit OTP type on both is "forget-password". */
const PASSWORD_RESET_OTP_PATHS = [
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
] as const
/** Every path whose responses must never reveal whether an account exists. */
const OTP_PROBE_PATHS = new Set<string>([
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/reset-password",
  ...PASSWORD_RESET_OTP_PATHS,
])

/**
 * Minimum gap between OTP emails for the same address. A code minted inside
 * this window is still valid (expiry is 5 minutes), so a second send adds
 * nothing but a second email — the historical double-send bug. 30s matches
 * common provider resend cooldowns and still allows a genuine "it never
 * arrived" retry quickly after.
 */
const OTP_SEND_COOLDOWN_MS = 30_000

/**
 * Verification-row identifier Better Auth's emailOTP plugin uses for OTP
 * codes: `${type}-otp-${email}` (toOTPIdentifier in the plugin). Cooldown
 * checks read the latest row for this identifier.
 */
const otpIdentifier = (type: string, email: string) =>
  `${type}-otp-${email.toLowerCase()}`

/**
 * Front-door signup validation. Better Auth re-validates internally; this
 * schema exists so malformed bodies die with field-specific messages before
 * any DB work, and so the contract the SignupPage posts against is explicit
 * in one place. Unknown keys (image, callbackURL, …) are stripped by zod —
 * only these three fields are gated. Exported for unit tests.
 */
export const signUpBodySchema = z.object({
  email: z.email("must be a valid email address"),
  password: z
    .string()
    .min(8, "must be at least 8 characters")
    .max(128, "must be at most 128 characters"),
  name: z.string().trim().min(1, "is required").max(200, "must be at most 200 characters"),
})

function zodIssuesDetail(error: z.ZodError): string {
  return error.issues
    .map(i => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ")
}

/**
 * True when a verification row was created inside the cooldown window. D1
 * returns createdAt as an ISO string; the adapter may hand back a Date —
 * accept both, and treat anything unparsable as "not in cooldown" (fail
 * open toward sending, never toward silently swallowing a first code).
 * Exported for unit tests.
 */
export function isWithinSendCooldown(createdAt: unknown): boolean {
  if (typeof createdAt !== "string" && !(createdAt instanceof Date)) return false
  const t = new Date(createdAt).getTime()
  return Number.isFinite(t) && Date.now() - t < OTP_SEND_COOLDOWN_MS
}

/**
 * Pull user.email out of a signUpEmail endpoint result. Works for BOTH
 * outcomes — the fresh-user 200 and the duplicate-email synthetic 200
 * (anti-enumeration: the fake user carries the requested address by design,
 * which is exactly what lets the after-hook send on repeat signups too).
 * Mirrors better-auth's own getEndpointResponse: APIError, non-200, or a
 * missing email → null (→ no send).
 */
async function emailFromSignUpResult(returned: unknown): Promise<string | null> {
  if (!returned || isAPIError(returned)) return null
  let data: unknown = returned
  if (returned instanceof Response) {
    if (returned.status !== 200) return null
    try {
      data = await returned.clone().json()
    } catch {
      return null
    }
  }
  const email = (data as { user?: { email?: unknown } } | null)?.user?.email
  return typeof email === "string" && email.length > 0 ? email : null
}

/**
 * Build a Better Auth instance bound to the request env.
 */
export function createAuth(env: Env, opts?: { baseURL?: string }) {
  const baseURL = opts?.baseURL ?? env.BETTER_AUTH_URL
  // Trusted origins: the API origin itself + the separate frontend origin (if
  // one is configured). Better Auth uses this list for its CSRF/origin checks
  // on cross-origin auth requests. Empty when no separate frontend is set.
  const trustedOrigins = [baseURL, env.FRONTEND_URL].filter(
    (o): o is string => typeof o === "string" && o.length > 0,
  )
  // Browsers only send a SameSite=None cookie over HTTPS, so a hardcoded
  // secure:true would prevent the session cookie from persisting on the
  // http://localhost dev origin. Better Auth auto-downgrades for localhost, but
  // we gate it explicitly to be safe across versions.
  //
  // Detect local dev by checking the host portion of the URL so we cover both
  // `http://localhost:8787` AND `http://127.0.0.1:8787` — the previous
  // `baseURL.includes("localhost")` substring check missed the latter, which
  // caused cookies to be set with `secure: true` over plain HTTP and silently
  // dropped by the browser.
  //
  // An explicit IS_LOCAL_DEV env wins over all (force `true` for local dev,
  // force `false` to test prod cookie behavior locally). NOTE: wrangler
  // delivers vars as STRINGS — the previous `typeof === "boolean"` check made
  // `.dev.vars`'s IS_LOCAL_DEV=true a silent no-op (e.g. when wrangler dev
  // rewrites the request host to a custom-domain route, the hostname fallback
  // misses and prod cookie attrs get set over http://localhost, which browsers
  // then reject). Accept "true"/"1"/true and "false"/"0"/false.
  const rawLocalFlag = env.IS_LOCAL_DEV
  const explicitLocal =
    rawLocalFlag === true || rawLocalFlag === "true" || rawLocalFlag === "1"
  const explicitProd =
    rawLocalFlag === false || rawLocalFlag === "false" || rawLocalFlag === "0"
  const isLocalDev =
    explicitLocal ||
    (!explicitProd &&
      (() => {
        try {
          const u = new URL(baseURL ?? "")
          return u.hostname === "localhost" || u.hostname === "127.0.0.1"
        } catch {
          return false
        }
      })())

  // Hygiene tripwire (audit: the bypass gate is env-trust-dependent). The
  // && isLocalDev gate below already IGNORES the flag in deployed envs, but
  // it did so silently — an operator who copied .dev.vars into prod secrets
  // would never know. Make the misconfiguration loud instead.
  if (env.E2E_OTP_BYPASS === "1" && !isLocalDev) {
    console.error(
      "[auth] E2E_OTP_BYPASS=1 is set but this is NOT a local dev deploy — " +
        "the deterministic OTP bypass is IGNORED here. Remove the flag from " +
        "this environment's vars/secrets.",
    )
  }

  // The after-hook below triggers the OTP send by calling THIS instance's
  // sendVerificationOTP endpoint. The options literal passed to betterAuth()
  // can't reference the instance it constructs, so the call routes through
  // this late-bound closure — assigned immediately after betterAuth()
  // returns, long before any per-request hook can fire.
  let sendVerificationOtp: (
    body: { email: string; type: "email-verification" },
  ) => Promise<unknown> = () => {
    throw new Error("sendVerificationOtp called before auth init completed")
  }

  const auth = betterAuth({
    // Native D1 — Better Auth manages its own Kysely D1 dialect.
    database: env.DB,
    secret: env.AUTH_SECRET,
    baseURL,

    trustedOrigins,

    user: {
      // Declare the extra column so Better Auth maps it to the `user` table.
      additionalFields: {
        onboardingComplete: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false, // not settable by the client directly
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      // Block sign-in until the OTP verifies the email. The verification code
      // is minted + emailed by the server at signUp.email time — see the
      // `hooks` option below (and the OTP DELIVERY note in the file header).
      requireEmailVerification: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },

    // After the OTP verifies the email, automatically create a session and
    // set the session cookie. WITHOUT this, /email-otp/verify-email returns
    // { token: null } with no Set-Cookie — the emailOTP plugin's verify
    // handler only calls createSession + setSessionCookie when this flag is
    // on (see better-auth/dist/plugins/email-otp/routes.mjs). The signup flow
    // relies on it: verify → cookie set → navigate to /dashboard → the
    // session is present so requireAuth passes. Without it, get-session
    // returns null right after verify and the user is bounced to /login.
    emailVerification: {
      autoSignInAfterVerification: true,
    },

    plugins: [
      emailOTP({
        // E2E/local-dev bypass (fixtures/env.ts E2E_OTP_FOR returns "999999"):
        // when E2E_OTP_BYPASS=1 AND this is a local dev deploy, the code is
        // deterministic so tests can verify without reading real email.
        // AUDIT M1: the IS_LOCAL_DEV co-gate is the hard safety — previously
        // only convention kept the flag out of production, and a stray
        // E2E_OTP_BYPASS=1 in a deployed environment would have let anyone
        // verify any email with "999999" (total signup takeover). Returning
        // undefined falls back to the plugin's secure random generator.
        generateOTP: () =>
          env.E2E_OTP_BYPASS === "1" && isLocalDev ? "999999" : undefined,
        // Delivers the 6-digit code via Resend. Throws if the key/sender is
        // missing — no silent dev fallback, by design.
        sendVerificationOTP: async ({ email, otp }) => {
          await sendOtpEmail(
            { to: email, otp },
            { apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM },
          )
        },
        storeOTP: "hashed", // hash codes at rest in the `verification` table
        otpLength: 6,
        expiresIn: 60 * 5, // 5 minutes
        allowedAttempts: 3,
        // The plugin's own auto-send stays OFF — our top-level hooks.after
        // below owns the signup send instead. Two reasons the plugin flag
        // isn't used: (1) its after-hook matcher excludes configs with
        // overrideDefaultEmailVerification (ours), and (2) the core
        // send-on-signup path is skipped entirely for the duplicate-email
        // synthetic 200 (anti-enumeration), which used to leave repeat
        // signups stuck on the verify step with no code. Our hook reads the
        // email off the endpoint RESPONSE, so it fires on both outcomes.
        sendVerificationOnSignUp: false,
        // Route core's email-verification flow through OTP (so
        // /api/auth/send-verification-email mints a code, not a link).
        overrideDefaultEmailVerification: true,
      }),
    ],

    advanced: {
      // Cookie prefix. Better Auth's default is "better-auth", producing
      // `better-auth.session_token`. We shorten it to "ja" so the session
      // cookie is `ja.session_token`. Applies consistently across session /
      // csrf / callback cookies (see cookies/index.mjs). Changing the prefix
      // invalidates any pre-existing cookies — users simply re-authenticate.
      cookiePrefix: "ja",

      // Cross-origin session cookie. The cookie must be sent on credentialed
      // cross-origin fetches from the frontend origin to this API origin.
      //
      // DEV (localhost:5173 → localhost:8787): SameSite=Lax. Different ports on
      // the same registrable domain ("localhost") count as same-site for cookie
      // purposes, so a Lax cookie rides along on credentialed cross-port
      // fetches. Crucially, Lax is the most permissive attribute that browsers
      // will ACCEPT over plain http — SameSite=None without Secure is silently
      // dropped by modern browsers (Chrome 80+, current FF/Safari), which was
      // the bug that previously made sessions never persist in dev.
      //
      // PROD (job-agent.example.dev → api-job-agent.example.dev, https):
      // SameSite=None + Secure. Genuinely cross-origin credentialed fetches
      // require None, and https makes Secure legal.
      //
      // COOKIE DOMAIN (prod only): the session cookie MUST also reach the WEB
      // subdomain. The frontend resolves sessions server-side by forwarding
      // the frontend-origin request's Cookie header to this API (see
      // packages/frontend/src/lib/auth.functions.ts) — with a host-only cookie
      // that header is empty on the web subdomain, so every authed route
      // bounces to /login (the prod login loop; dev never sees it because
      // localhost ports share one cookie jar). Scoping to the parent domain
      // via COOKIE_DOMAIN makes the browser send it to BOTH subdomains.
      // Tradeoff: the cookie becomes visible to other subdomains of a domain
      // you control — acceptable for a single-operator domain. Local dev is
      // exempt (host-only works there) and a bare hostname is rejected.
      defaultCookieAttributes: {
        sameSite: isLocalDev ? "lax" : "none",
        secure: !isLocalDev,
        domain:
          !isLocalDev && env.COOKIE_DOMAIN && env.COOKIE_DOMAIN.startsWith(".")
            ? env.COOKIE_DOMAIN
            : undefined,
      },
    },

    // NOTE: no databaseHooks here, deliberately. onboardingComplete stays 0
    // after email verification so NEW signups are routed through the
    // onboarding wizard (profile → CV → connect browser) by the requireAuth
    // guard (428 → the frontend redirects to /onboarding). The wizard's
    // POST /api/onboarding is the single writer that flips the flag to 1.
    // (An earlier hook force-flipped it at OTP-verify, which skipped the
    // wizard entirely and sent fresh users to a bare dashboard.)

    // ─── Signup OTP: server-driven send + resend cooldown ─────────────────
    // These run for BOTH HTTP requests and internal auth.api.* calls (they
    // share the same dispatch pipeline), which is what makes the cooldown
    // gate below effective against every path that could mint a code.
    hooks: {
      before: createAuthMiddleware(async ctx => {
        const path = ctx.path ?? ""

        // (1) Front-door zod validation on signup — field-specific 400s
        // before any DB work. Returning undefined continues the pipeline.
        if (path === SIGNUP_PATH) {
          const parsed = signUpBodySchema.safeParse(ctx.body)
          if (!parsed.success) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_SIGNUP_BODY",
              message: `Invalid sign-up body — ${zodIssuesDetail(parsed.error)}`,
            })
          }
          return
        }

        // (2) Cooldown gate on EVERY OTP send path. A code minted less than
        // OTP_SEND_COOLDOWN_MS ago is still valid, so a second mint would
        // only produce a second email (the reported double-send — and, on
        // the password-reset paths, a mail-bombing vector). Returning a
        // truthy non-context value SHORT-CIRCUITS the endpoint with that
        // value as its response — callers see the same { success: true }
        // shape both endpoints already return, so double form submits, the
        // legacy frontend's explicit send during a deploy window, impatient
        // Resend clicks, and reset-OTP spam all no-op silently.
        if (path === SEND_OTP_PATH) {
          const body = ctx.body as { email?: unknown; type?: unknown } | undefined
          const email =
            typeof body?.email === "string" ? body.email.toLowerCase() : ""
          const type = typeof body?.type === "string" ? body.type : ""
          if (!email || !type) return
          const latest = await ctx.context.internalAdapter.findVerificationValue(
            otpIdentifier(type, email),
          )
          if (latest && isWithinSendCooldown(latest.createdAt)) {
            return { success: true }
          }
        }
        if ((PASSWORD_RESET_OTP_PATHS as readonly string[]).includes(path)) {
          const body = ctx.body as { email?: unknown } | undefined
          const email =
            typeof body?.email === "string" ? body.email.toLowerCase() : ""
          if (!email) return
          const latest = await ctx.context.internalAdapter.findVerificationValue(
            otpIdentifier("forget-password", email),
          )
          if (latest && isWithinSendCooldown(latest.createdAt)) {
            return { success: true }
          }
        }
      }),

      after: createAuthMiddleware(async ctx => {
        const path = ctx.path ?? ""

        // (1) signUp.email completed → mint + send the code server-side.
        // This is the ONLY signup send; the frontend never calls the send
        // endpoint itself. Fires on fresh AND duplicate-email synthetic
        // signups (see emailFromSignUpResult). The internal endpoint call
        // re-enters the before-hook above, so a duplicate submit seconds
        // after the first is already a cooldown no-op before it even
        // reaches the mint.
        if (path === SIGNUP_PATH) {
          const email = await emailFromSignUpResult(ctx.context.returned)
          if (email) {
            try {
              const result = (await sendVerificationOtp({
                email,
                type: "email-verification",
              })) as { error?: unknown } | undefined
              if (result && typeof result === "object" && result.error) {
                ctx.context.logger.error(
                  `[signup-otp] send endpoint rejected for ${email}: ${result.error}`,
                )
              }
            } catch (e) {
              // The endpoint already swallows Resend failures (they surface
              // as toasts via the frontend's Resend button) — log and move
              // on so a mail-provider blip never fails the signup response.
              ctx.context.logger.error(
                `[signup-otp] send failed for ${email}: ${e}`,
              )
            }
          }
          return
        }

        // (2) Anti-enumeration normalization on the OTP probe endpoints.
        // Verified against better-auth 1.6.23: check-verification-otp throws
        // USER_NOT_FOUND for unknown emails but INVALID_OTP for known ones —
        // a free account-existence oracle that defeats the deliberate
        // synthetic-200 on /sign-up/email. Swap any USER_NOT_FOUND on these
        // paths for a byte-identical INVALID_OTP error (same status, code,
        // message, and body key order as the plugin's own INVALID_OTP
        // throw), so "no account" and "wrong code" are indistinguishable.
        // The other paths are already uniform today; the swap is a no-op
        // there and future-proofs them.
        if (OTP_PROBE_PATHS.has(path)) {
          const returned = ctx.context.returned
          if (isAPIError(returned)) {
            const body = (returned as { body?: { code?: unknown } }).body
            const code =
              body && typeof body === "object"
                ? (body as { code?: unknown }).code
                : undefined
            if (code === "USER_NOT_FOUND") {
              // Return the error ITSELF — the middleware layer wraps handler
              // returns in { response, headers } when returnHeaders is set
              // (dispatch sets it for after-hooks), so wrapping it here
              // again would serialize as {"response":{…}} instead of the
              // plain error body.
              return new APIError("BAD_REQUEST", {
                message: "Invalid OTP",
                code: "INVALID_OTP",
              })
            }
          }
        }
      }),
    },
  })

  sendVerificationOtp = body => auth.api.sendVerificationOTP({ body })
  return auth
}

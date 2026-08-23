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
// =============================================================================
import { betterAuth } from "better-auth"
import { emailOTP } from "better-auth/plugins"
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

  return betterAuth({
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
      // Block sign-in until the OTP verifies the email. Signup sends the OTP
      // immediately (sendVerificationOnSignUp below).
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
        // when E2E_OTP_BYPASS=1 the code is deterministic so tests can verify
        // without reading real email. The flag lives ONLY in local .dev.vars —
        // never set it in production deploys. Returning undefined falls back
        // to the plugin's secure random generator.
        generateOTP: () =>
          env.E2E_OTP_BYPASS === "1" ? "999999" : undefined,
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
        // We do NOT auto-send the OTP at signUp.email. Better Auth's core
        // signUpEmail handler short-circuits to a synthetic 200 response for
        // duplicate emails (anti-enumeration) BEFORE it would reach the
        // send path — so a user who signs up twice with the same address never
        // gets a code and is stuck on the verify step. Instead the frontend
        // explicitly calls sendVerificationOtp right after signUp.email
        // returns, which mints + sends a fresh code regardless of whether the
        // signup created a new user or hit the duplicate path.
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
  })
}

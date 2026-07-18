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

  return betterAuth({
    // Native D1 — Better Auth manages its own Kysely D1 dialect.
    database: env.DB,
    secret: env.AUTH_SECRET,
    baseURL,

    // The app is served same-origin by Workers Assets, so the only trusted
    // origin is itself. (Widened later if a separate frontend domain ships.)
    trustedOrigins: baseURL ? [baseURL] : [],

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

    plugins: [
      emailOTP({
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
        // Mint + email the OTP as soon as the user signs up.
        sendVerificationOnSignUp: true,
        // Route core's email-verification flow through OTP (so
        // /api/auth/send-verification-email mints a code, not a link).
        overrideDefaultEmailVerification: true,
      }),
    ],
  })
}

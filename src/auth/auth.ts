// =============================================================================
// Better Auth instance — magic-link auth on Cloudflare D1 + Resend.
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
// DEV MODE: when RESEND_API_KEY is unset, magic links are NOT emailed — the
// sendMagicLink callback logs the URL to console and stashes it on the request
// via the `__devMagicLink` header so the Stage-4 route can surface it for
// click-through testing with zero provider setup.
// =============================================================================
import { betterAuth } from "better-auth"
import { magicLink } from "better-auth/plugins"
import type { Env } from "../types"
import { sendMagicLinkEmail } from "./resend"

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
      // Magic link is the only login method. Explicitly disable password auth.
      enabled: false,
    },

    plugins: [
      magicLink({
        // 10-minute link expiry (default is 5). Gives email delivery slack.
        expiresIn: 60 * 10,
        sendMagicLink: async ({ email, url, token }, ctx) => {
          const result = await sendMagicLinkEmail(
            { to: email, url, token },
            { apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM },
          )
          if (!result.sent && result.devUrl) {
            // Dev path — surface the link so the caller (the auth route) can
            // expose it via a header for local click-through. We stash it on
            // the context's response headers if available.
            try {
              ctx?.context?.setCookie?.("dev-magic-link", result.devUrl)
            } catch {
              // ctx shape varies; the console.log in sendMagicLinkEmail is the
              // primary dev signal. Not worth failing the flow over.
            }
          }
        },
      }),
    ],
  })
}

// =============================================================================
// Better Auth CLI bootstrap — used ONLY by `npx @better-auth/cli generate`.
// =============================================================================
// The real auth instance (auth.ts) is built per-request from the Worker env
// (D1 binding, secrets), which the CLI can't load. This file constructs a
// throwaway instance with stub bindings so the CLI can introspect the schema
// (tables, columns, additionalFields) and emit the canonical Drizzle schema.
//
// Keep this in sync with createAuth() in auth.ts — same options shape, just
// stub env. The CLI reads `auth.options` to derive the schema.
// =============================================================================
import { betterAuth } from "better-auth"
import { emailOTP } from "better-auth/plugins"
import Database from "better-sqlite3"

// In-memory SQLite via better-sqlite3. The CLI initializes the adapter (which
// it needs to derive the schema), so we give it a real, empty, throwaway DB.
// This is dev-tooling only — never imported by the Worker runtime.
const memDb = new Database(":memory:")

// Better Auth accepts a better-sqlite3 instance directly via the
// betterSqlite3 adapter (it detects the constructor). Cast for the D1-shaped
// `database` option we use in production.
const db = memDb as unknown as Parameters<typeof betterAuth>[0]["database"]

export const auth = betterAuth({
  database: db,
  secret: "cli-bootstrap-secret-not-used-at-runtime",
  baseURL: "http://localhost:8787",

  trustedOrigins: ["http://localhost:5173"],

  user: {
    additionalFields: {
      onboardingComplete: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },

  emailVerification: {
    autoSignInAfterVerification: true,
  },

  plugins: [
    emailOTP({
      sendVerificationOTP: async () => {},
      storeOTP: "hashed",
      otpLength: 6,
      expiresIn: 60 * 5,
      allowedAttempts: 3,
      sendVerificationOnSignUp: false,
      overrideDefaultEmailVerification: true,
    }),
  ],

  advanced: {
    cookiePrefix: "ja",
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: false,
    },
  },
})

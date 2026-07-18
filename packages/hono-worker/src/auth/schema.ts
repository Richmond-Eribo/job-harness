// =============================================================================
// Drizzle schema for Better Auth on D1 (SQLite).
// =============================================================================
// Better Auth needs four core tables — user, session, verification, account —
// and we extend `user` with our own onboarding/profile columns. This schema is
// passed to drizzleAdapter() at runtime so Better Auth knows the column shape,
// and mirrored as raw SQL in migrations/0001_auth.sql so the D1 tables actually
// exist.
//
// snake_case names are used because Better Auth's CLI generates snake_case by
// default and the adapter defaults to snake_case field mapping — matching that
// convention avoids a `usePlural`/`camelCase` mismatch.
// =============================================================================
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// --- Core Better Auth tables ------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  // Better Auth core:
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  // Our extensions:
  // Whether the user has completed the profile + CV onboarding. Until true, the
  // onboarding gate (Stage 7) blocks agent runs and forces /onboarding.
  onboardingComplete: integer("onboarding_complete", { mode: "boolean" })
    .notNull()
    .default(false),
})

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
})

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
})

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

// Schema object handed to drizzleAdapter(). Keys are singular table names.
export const authSchema = {
  user,
  session,
  verification,
  account,
}

export type AuthUser = typeof user.$inferSelect
export type AuthSession = typeof session.$inferSelect

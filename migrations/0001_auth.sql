-- 0001_auth.sql — Better Auth core tables + onboarding/profile columns.
-- Mirrors src/auth/schema.ts (Drizzle) so the runtime schema and the actual D1
-- tables stay in lockstep. snake_case to match Better Auth defaults.
--
-- Apply with: npx wrangler d1 migrations apply agent-harness-auth --remote
-- (and --local for the dev DB)

-- user -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "email"               TEXT NOT NULL UNIQUE,
  "email_verified"      INTEGER NOT NULL DEFAULT 0,
  "name"                TEXT NOT NULL,
  "image"               TEXT,
  "created_at"          INTEGER NOT NULL,
  "updated_at"          INTEGER NOT NULL,
  -- Our extension: profile + CV onboarding gate (Stage 7).
  "onboarding_complete" INTEGER NOT NULL DEFAULT 0
);

-- session --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "expires_at"  INTEGER NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "created_at"  INTEGER NOT NULL,
  "updated_at"  INTEGER NOT NULL,
  "ip_address"  TEXT,
  "user_agent"  TEXT,
  "user_id"     TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session"("user_id");

-- verification ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "verification" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "identifier"  TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "expires_at"  INTEGER NOT NULL,
  "created_at"  INTEGER,
  "updated_at"  INTEGER
);

-- account --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "account" (
  "id"                        TEXT PRIMARY KEY NOT NULL,
  "account_id"                TEXT NOT NULL,
  "provider_id"               TEXT NOT NULL,
  "user_id"                   TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token"              TEXT,
  "refresh_token"             TEXT,
  "access_token_expires_at"   INTEGER,
  "refresh_token_expires_at"  INTEGER,
  "scope"                     TEXT,
  "id_token"                  TEXT,
  "password"                  TEXT,
  "created_at"                INTEGER NOT NULL,
  "updated_at"                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account"("user_id");

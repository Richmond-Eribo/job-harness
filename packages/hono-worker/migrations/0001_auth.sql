-- 0001_auth.sql — Better Auth core tables + onboarding/profile columns.
-- Mirrors the shape Better Auth 1.6.x queries at runtime. Better Auth's default
-- field names are camelCase (emailVerified, createdAt, etc.) — verified in
-- node_modules/@better-auth/core/dist/db/get-tables.mjs. The runtime queries
-- these exact column names, so the D1 schema MUST match or every insert/select
-- throws "no such column" → empty 500.
--
-- Apply with: npx wrangler d1 migrations apply agent-harness-auth --local
-- (and --remote for the prod DB)

-- user -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "email"               TEXT NOT NULL UNIQUE,
  "emailVerified"       INTEGER NOT NULL DEFAULT 0,    -- camelCase (Better Auth default)
  "name"                TEXT NOT NULL,
  "image"               TEXT,
  "createdAt"           INTEGER NOT NULL,
  "updatedAt"           INTEGER NOT NULL,
  -- Our extension: profile + CV onboarding gate (Stage 7).
  "onboardingComplete"  INTEGER NOT NULL DEFAULT 0
);

-- session --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "expiresAt"   INTEGER NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "createdAt"   INTEGER NOT NULL,
  "updatedAt"   INTEGER NOT NULL,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "userId"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");

-- verification ---------------------------------------------------------
-- Used by the magic-link plugin to store the one-time sign-in tokens.
CREATE TABLE IF NOT EXISTS "verification" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "identifier"  TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "expiresAt"   INTEGER NOT NULL,
  "createdAt"   INTEGER,
  "updatedAt"   INTEGER
);

-- account --------------------------------------------------------------
-- Used by credential/OAuth accounts. Magic-link uses the verification table,
-- but this must exist for Better Auth's schema expectations.
CREATE TABLE IF NOT EXISTS "account" (
  "id"                        TEXT PRIMARY KEY NOT NULL,
  "accountId"                 TEXT NOT NULL,
  "providerId"                TEXT NOT NULL,
  "userId"                    TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken"               TEXT,
  "refreshToken"              TEXT,
  "accessTokenExpiresAt"      INTEGER,
  "refreshTokenExpiresAt"     INTEGER,
  "scope"                     TEXT,
  "idToken"                   TEXT,
  "password"                  TEXT,
  "createdAt"                 INTEGER NOT NULL,
  "updatedAt"                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");

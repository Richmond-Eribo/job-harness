-- 0002_camelcase.sql — Fix column casing to match Better Auth runtime defaults.
--
-- 0001 used snake_case columns (email_verified, created_at) but Better Auth
-- 1.6.x queries camelCase (emailVerified, createdAt) at runtime — causing
-- "no such column" 500s on every auth DB operation. This migration drops the
-- old tables and recreates them with the correct camelCase columns.
--
-- (D1 migrations are append-only — wrangler tracks by filename, so we can't
-- just edit 0001. This is the corrective migration. Fresh deployments apply
-- 0001 then 0002; the net effect is the camelCase schema.)
--
-- Safe to re-run: the data in these tables is auth/session/verification tokens
-- only. No user-created jobs/profiles are lost (those live in the per-user DOs).

DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "user";

-- user -----------------------------------------------------------------
CREATE TABLE "user" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "email"               TEXT NOT NULL UNIQUE,
  "emailVerified"       INTEGER NOT NULL DEFAULT 0,
  "name"                TEXT NOT NULL,
  "image"               TEXT,
  "createdAt"           INTEGER NOT NULL,
  "updatedAt"           INTEGER NOT NULL,
  "onboardingComplete"  INTEGER NOT NULL DEFAULT 0
);

-- session --------------------------------------------------------------
CREATE TABLE "session" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "expiresAt"   INTEGER NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "createdAt"   INTEGER NOT NULL,
  "updatedAt"   INTEGER NOT NULL,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "userId"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- verification ---------------------------------------------------------
CREATE TABLE "verification" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "identifier"  TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "expiresAt"   INTEGER NOT NULL,
  "createdAt"   INTEGER,
  "updatedAt"   INTEGER
);

-- account --------------------------------------------------------------
CREATE TABLE "account" (
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
CREATE INDEX "account_userId_idx" ON "account"("userId");

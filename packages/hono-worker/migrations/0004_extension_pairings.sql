-- 0004_extension_pairings.sql — Chrome extension pairing + refresh tokens.
--
-- Unblocks the browser extension: previously the ONLY way to authenticate the
-- extension's WebSocket was a short-lived (1h) JWT the dashboard had no UI to
-- mint or hand off, and the extension had no code to send it. This migration
-- adds the durable state for a proper pairing flow:
--
--   1. Dashboard (session-authed) mints a 6-char single-use pairing code with
--      a 5-minute expiry → `extension_pairings`.
--   2. Extension popup exchanges the code (POST /api/browser/pair/redeem, no
--      session — the code itself is the credential) for a long-lived refresh
--      token. Only the SHA-256 hash of the refresh token is stored, never the
--      raw value (same principle as password storage) → `extension_refresh_tokens`.
--   3. Extension silently exchanges the refresh token for short-lived (1h)
--      access-token JWTs (POST /api/browser/refresh) using the existing
--      mintExtensionToken()/verifyExtensionToken() machinery in
--      src/auth/extension-token.ts — no schema change needed there.
--
-- Both tables live in D1 (not a per-user DO) because pairing/redeem happen
-- BEFORE we know which DO to route to — we need a global lookup by code/hash.

CREATE TABLE IF NOT EXISTS "extension_pairings" (
  "code"          TEXT PRIMARY KEY NOT NULL,
  "user_id"       TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at"    INTEGER NOT NULL,
  "expires_at"    INTEGER NOT NULL,
  "redeemed_at"   INTEGER
);
CREATE INDEX IF NOT EXISTS "extension_pairings_user_idx" ON "extension_pairings"("user_id");

CREATE TABLE IF NOT EXISTS "extension_refresh_tokens" (
  "token_hash"    TEXT PRIMARY KEY NOT NULL,
  "user_id"       TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at"    INTEGER NOT NULL,
  "last_used_at"  INTEGER,
  "revoked_at"    INTEGER
);
CREATE INDEX IF NOT EXISTS "extension_refresh_tokens_user_idx" ON "extension_refresh_tokens"("user_id");

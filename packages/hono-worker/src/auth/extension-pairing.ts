// =============================================================================
// Extension pairing — turns a session-authed "pair my browser" click into a
// long-lived refresh token the extension can silently renew forever, without
// ever asking the user to copy/paste a raw JWT.
// =============================================================================
// FLOW
//   1. Dashboard (session-authed):      POST /api/browser/pair
//        → mints a 6-char code, stores {code, userId, expiresAt} in D1,
//          returns {code, expiresIn}. User reads the code off the screen.
//   2. Extension popup (NO session — the code IS the credential):
//                                        POST /api/browser/pair/redeem {code}
//        → validates + single-use-consumes the code, mints a refresh token,
//          stores only its SHA-256 hash in D1, returns the RAW refresh token
//          (shown once, exactly like the pairing code) + a short-lived access
//          token so the extension can connect immediately.
//   3. Extension (ongoing, no user interaction):
//                                        POST /api/browser/refresh {refreshToken}
//        → looks up the hash, mints a fresh 1h access token via the existing
//          mintExtensionToken() machinery, updates last_used_at.
//
// WHY A CODE INSTEAD OF HANDING OVER THE JWT DIRECTLY
// A raw JWT copy-pasted into a popup is easy to mistype/truncate and, worse,
// trains users to paste bearer credentials into random text fields. A 6-char
// code is short-lived (5 min), single-use, and useless outside the pairing
// exchange — even if shoulder-surfed, the window to abuse it is tiny and it
// can't be replayed after redemption.
//
// WHY STORE ONLY A HASH OF THE REFRESH TOKEN
// Same rationale as password storage: if the D1 row leaks, the attacker gets
// a hash, not a usable credential. SHA-256 (not bcrypt/scrypt) is fine here
// because the refresh token itself is a high-entropy random value, not a
// user-chosen password — there's no offline brute-force concern the way there
// is with passwords.
// =============================================================================
import type { Context } from "hono"
import type { AppEnv } from "../types/app-env"
import {
  mintExtensionToken,
  effectiveSecret,
  TOKEN_TTL_SECONDS,
} from "./extension-token"

const PAIRING_CODE_TTL_SECONDS = 5 * 60 // 5 minutes, single-use
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I — avoids operator transcription errors

function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let out = ""
  for (const b of bytes)
    out += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

function generateRefreshToken(): string {
  // 32 random bytes, base64url — high-entropy, opaque (not a JWT; no payload
  // to parse, so a leaked D1 row alone reveals nothing about the token format).
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Route handler: POST /api/browser/pair (session-gated).
 * Mints a short-lived single-use pairing code for the session user.
 */
export async function createPairingCodeRoute(c: Context<AppEnv>) {
  const userId = c.get("userId")
  const now = Date.now()
  const expiresAt = now + PAIRING_CODE_TTL_SECONDS * 1000

  // Collision retry — astronomically unlikely with 6 chars from a 32-symbol
  // alphabet (~1 billion combinations), but cheap to guard anyway.
  let code = generatePairingCode()
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await c.env.DB.prepare(
      `SELECT code FROM extension_pairings WHERE code = ?`,
    )
      .bind(code)
      .first()
    if (!existing) break
    code = generatePairingCode()
  }

  await c.env.DB.prepare(
    `INSERT INTO extension_pairings (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(code, userId, now, expiresAt)
    .run()

  return c.json({ code, expiresIn: PAIRING_CODE_TTL_SECONDS })
}

/**
 * Route handler: POST /api/browser/pair/redeem (NO session — the code is the
 * credential). Validates + single-use-consumes the code, mints a refresh
 * token + an immediate access token.
 */
export async function redeemPairingCodeRoute(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => ({}))
  const code =
    typeof body?.code === "string" ? body.code.trim().toUpperCase() : ""
  if (!code) return c.json({ error: "code required" }, 400)

  const row = await c.env.DB.prepare(
    `SELECT user_id, expires_at, redeemed_at FROM extension_pairings WHERE code = ?`,
  )
    .bind(code)
    .first<{
      user_id: string
      expires_at: number
      redeemed_at: number | null
    }>()

  if (!row) return c.json({ error: "Invalid or expired pairing code" }, 400)
  if (row.redeemed_at)
    return c.json({ error: "Pairing code already used" }, 400)
  if (row.expires_at < Date.now()) {
    return c.json({ error: "Pairing code expired. Generate a new one." }, 400)
  }

  const now = Date.now()
  // Mark redeemed FIRST (single-use enforcement) — if the token mint below
  // throws, the code is still burned, which is the safe failure mode (forces
  // a fresh pair attempt rather than allowing a retry-replay window).
  await c.env.DB.prepare(
    `UPDATE extension_pairings SET redeemed_at = ? WHERE code = ?`,
  )
    .bind(now, code)
    .run()

  const refreshToken = generateRefreshToken()
  const tokenHash = await sha256Hex(refreshToken)
  await c.env.DB.prepare(
    `INSERT INTO extension_refresh_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)`,
  )
    .bind(tokenHash, row.user_id, now)
    .run()

  const accessToken = await mintExtensionToken(
    row.user_id,
    effectiveSecret(c.env),
  )

  return c.json({
    refreshToken,
    accessToken,
    accessTokenExpiresIn: TOKEN_TTL_SECONDS,
  })
}

/**
 * Route handler: POST /api/browser/refresh (NO session — the refresh token is
 * the credential). Exchanges a valid, non-revoked refresh token for a fresh
 * 1h access token. Called silently by the extension whenever its access
 * token is close to expiry or a relay connection is rejected as unauthorized.
 */
export async function refreshAccessTokenRoute(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => ({}))
  const refreshToken =
    typeof body?.refreshToken === "string" ? body.refreshToken : ""
  if (!refreshToken) return c.json({ error: "refreshToken required" }, 400)

  const tokenHash = await sha256Hex(refreshToken)
  const row = await c.env.DB.prepare(
    `SELECT user_id, revoked_at FROM extension_refresh_tokens WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ user_id: string; revoked_at: number | null }>()

  if (!row || row.revoked_at) {
    return c.json(
      { error: "Invalid or revoked refresh token. Re-pair the extension." },
      401,
    )
  }

  await c.env.DB.prepare(
    `UPDATE extension_refresh_tokens SET last_used_at = ? WHERE token_hash = ?`,
  )
    .bind(Date.now(), tokenHash)
    .run()

  const accessToken = await mintExtensionToken(
    row.user_id,
    effectiveSecret(c.env),
  )
  return c.json({ accessToken, accessTokenExpiresIn: TOKEN_TTL_SECONDS })
}

/**
 * Route handler: POST /api/browser/unpair (session-gated). Revokes ALL
 * refresh tokens for the session user — used by the "Disconnect" /
 * "Forget this browser" button so a stolen laptop/extension install can be
 * cut off without rotating the account's whole AUTH_SECRET.
 */
export async function revokeAllRefreshTokensRoute(c: Context<AppEnv>) {
  const userId = c.get("userId")
  const result = await c.env.DB.prepare(
    `UPDATE extension_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), userId)
    .run()
  return c.json({ revoked: result.meta?.rows_written ?? 0 })
}

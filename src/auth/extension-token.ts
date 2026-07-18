// =============================================================================
// Extension tokens — bind a Chrome extension connection to a specific user.
// =============================================================================
// PROBLEM
// The browser relay is a WebSocket: the extension opens wss://worker/browser/
// relay. WS upgrades can't carry a session cookie reliably (and the extension
// isn't a browser navigation), so we can't use the session middleware to learn
// WHICH user's Chrome is connecting. Without this, the Worker can't route the
// socket to the right per-user relay DO.
//
// SOLUTION
// The dashboard (session-authenticated) mints a short-lived signed token bound
// to the session userId. The extension stores it and appends it on the WS URL:
//   wss://worker/browser/relay?token=<jwt>
// The relay route validates the token, extracts the userId, and routes to
// getAgentByName(BROWSER_RELAY, userId). Tokens expire (default 24h) and are
// re-minted by re-opening the dashboard panel.
//
// This is a stateless JWT (HMAC-SHA256 via Web Crypto) — no DB lookup on the
// hot WS path, and revocation is simply short expiry + re-mint.
// =============================================================================
import type { Context } from "hono"
import type { AppEnv } from "../types/app-env"

const TOKEN_TTL_SECONDS = 60 * 60 * 24 // 24 hours
const ALG = "HS256"

function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  let bin = ""
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

/** Mint a signed extension token for a user. */
export async function mintExtensionToken(
  userId: string,
  secret: string,
  ttlSeconds = TOKEN_TTL_SECONDS,
): Promise<string> {
  const header = { alg: ALG, typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: userId,
    iat: now,
    exp: now + ttlSeconds,
  }
  const headerB64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  )
  const payloadB64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64urlEncode(sig)}`
}

export interface VerifiedToken {
  userId: string
  exp: number
}

/**
 * Verify an extension token. Returns the userId on success, or null if the
 * token is invalid, malformed, or expired.
 */
export async function verifyExtensionToken(
  token: string,
  secret: string,
): Promise<VerifiedToken | null> {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  const signingInput = `${headerB64}.${payloadB64}`
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    b64urlDecode(sigB64),
    new TextEncoder().encode(signingInput),
  )
  if (!ok) return null
  let payload: any
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)))
  } catch {
    return null
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null // expired
  }
  if (typeof payload.sub !== "string" || !payload.sub) return null
  return { userId: payload.sub, exp: payload.exp }
}

/**
 * Route handler: POST /api/browser/extension-token.
 * Mints a token for the session user. The dashboard surfaces it (or a QR) for
 * the extension to copy/store.
 */
export async function issueExtensionTokenRoute(c: Context<AppEnv>) {
  const userId = c.get("userId")
  const token = await mintExtensionToken(userId, c.env.AUTH_SECRET)
  return c.json({ token, expiresIn: TOKEN_TTL_SECONDS })
}

/**
 * Extract + verify the extension token from a WS upgrade URL. Returns the
 * userId, or null if no valid token is present.
 */
export async function userIdFromRelayRequest(
  url: URL,
  secret: string,
): Promise<string | null> {
  const token = url.searchParams.get("token")
  if (!token) return null
  const verified = await verifyExtensionToken(token, secret)
  return verified?.userId ?? null
}

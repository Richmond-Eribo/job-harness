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
// to the session userId. The extension stores it and presents it to the relay
// in ONE of two ways (P1-6 — both supported for back-compat):
//
//   1. PREFERRED — the WebSocket subprotocol:
//        new WebSocket(url, [`ja-ext-token.${jwt}`])
//      The token never touches a URL, so it can't leak via browser history,
//      access logs, Referer, or proxy traces. The browser strips the
//      subprotocol from these channels; only the server sees it.
//
//   2. LEGACY — the URL query string:
//        wss://worker/browser/relay?token=<jwt>
//      Still accepted so existing extension installs keep working until they
//      upgrade. New extension builds should switch to (1).
//
// SECURITY (P1-6):
//   - TTL reduced from 24h → 1h. A leaked token is exploitable for a much
//     smaller window. The dashboard mints a fresh token on each panel open,
//     so 1h is plenty for a working session.
//   - Token is signed with EXTENSION_TOKEN_SECRET if present (preferred —
//     independent rotation: revoking extension tokens by rotating the secret
//     no longer also logs out every web user). Falls back to AUTH_SECRET for
//     back-compat so existing deployments keep working until an operator sets
//     the new var.
//   - `iat` is now validated: must be present, a number, and not in the future.
//     Closes the "issue a token dated 1h from now" trick.
//
// This is a stateless JWT (HMAC-SHA256 via Web Crypto) — no DB lookup on the
// hot WS path, and revocation is simply short expiry + re-mint.
// =============================================================================
import type { Context } from "hono"
import type { AppEnv } from "../types/app-env"

// P1-6: was 24h. Reduced to 1h so a leaked token has a small exploitation
// window. The dashboard re-mints on each panel open, so working sessions are
// unaffected.
const TOKEN_TTL_SECONDS = 60 * 60 // 1 hour
const ALG = "HS256"

// Subprotocol prefix the extension must use when presenting the token via the
// WS handshake (replacing the URL-query approach). Keep this in lock-step with
// the extension's `new WebSocket(url, [...])` call.
export const EXT_TOKEN_SUBPROTOCOL_PREFIX = "ja-ext-token."

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

/**
 * Resolve the effective signing secret. Prefers EXTENSION_TOKEN_SECRET so the
 * extension token namespace can be rotated independently of AUTH_SECRET (and
 * therefore independently of every web session). Falls back to AUTH_SECRET
 * for back-compat — does NOT throw if the new var is unset.
 */
function effectiveSecret(env: { EXTENSION_TOKEN_SECRET?: string; AUTH_SECRET: string }): string {
  return env.EXTENSION_TOKEN_SECRET && env.EXTENSION_TOKEN_SECRET.length > 0
    ? env.EXTENSION_TOKEN_SECRET
    : env.AUTH_SECRET
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
 * token is invalid, malformed, expired, or has a future-dated `iat`.
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
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return null // expired (or exp missing/malformed)
  }
  // P1-6/H1: validate `iat`. Must be present, a number, and not in the future
  // (allow up to 60s of clock skew between mint and verify). Rejects the
  // "minted next hour" trick and surfaces seriously-mistuned clocks.
  if (
    typeof payload.iat !== "number" ||
    payload.iat > now + 60
  ) {
    return null
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
  // P1-6/H2: sign with EXTENSION_TOKEN_SECRET if present, else fall back.
  const token = await mintExtensionToken(userId, effectiveSecret(c.env))
  return c.json({
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    // Tell the client which delivery channel to use. The extension should
    // prefer the subprotocol form; the URL form is supported for old builds.
    delivery: "subprotocol-or-url",
    subprotocolPrefix: EXT_TOKEN_SUBPROTOCOL_PREFIX,
  })
}

/**
 * Extract + verify the extension token from a WS upgrade request. Tries the
 * subprotocol first (preferred — token never appears in URLs/logs), then
 * falls back to the URL query param (legacy). Returns the userId, or null.
 */
export async function userIdFromRelayRequest(
  url: URL,
  secret: string,
  headers?: Headers,
): Promise<string | null> {
  // 1. Preferred: `Sec-WebSocket-Protocol: ja-ext-token.<jwt>`. The browser
  //    packs the client-offered subprotocols into this header during the WS
  //    handshake. We pick the first one matching our prefix.
  if (headers) {
    const rawProtos = headers.get("sec-websocket-protocol") ?? ""
    for (const proto of rawProtos.split(",").map(s => s.trim())) {
      if (proto.startsWith(EXT_TOKEN_SUBPROTOCOL_PREFIX)) {
        const token = proto.slice(EXT_TOKEN_SUBPROTOCOL_PREFIX.length)
        const verified = await verifyExtensionToken(token, secret)
        if (verified) return verified.userId
      }
    }
  }
  // 2. Legacy: ?token=<jwt>. Logged in browser history, referrers, and server
  //    access logs — kept only so existing extension builds keep working.
  const token = url.searchParams.get("token")
  if (!token) return null
  const verified = await verifyExtensionToken(token, secret)
  return verified?.userId ?? null
}

/** Resolve the effective secret from env (re-exported for tests/routers). */
export { effectiveSecret }

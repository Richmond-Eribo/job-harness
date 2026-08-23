import { describe, it, expect } from "vitest"

/**
 * Unit tests for the browser-relay extension tokens (src/auth/extension-token.ts).
 *
 * These are stateless HMAC-signed JWTs that bind a Chrome extension's WebSocket
 * connection to a specific user. The token is validated on the WS upgrade to
 * route the socket to the right per-user relay DO. We test:
 *   1. Sign → verify roundtrip recovers the userId.
 *   2. Tampered tokens are rejected.
 *   3. Tokens signed with the wrong secret are rejected.
 *   4. Expired tokens are rejected.
 *   5. Malformed tokens are rejected.
 */
const {
  mintExtensionToken,
  verifyExtensionToken,
  userIdFromRelayRequest,
} = await import("../auth/extension-token")

const SECRET = "test-secret-32-bytes-long-aaaaaa"
const USER_ID = "user_abc123"

describe("extension tokens — sign/verify roundtrip", () => {
  it("verifies a freshly minted token and returns the userId", async () => {
    const token = await mintExtensionToken(USER_ID, SECRET)
    expect(typeof token).toBe("string")
    const verified = await verifyExtensionToken(token, SECRET)
    expect(verified).not.toBeNull()
    expect(verified!.userId).toBe(USER_ID)
  })

  it("rejects a token signed with a different secret", async () => {
    const token = await mintExtensionToken(USER_ID, SECRET)
    const verified = await verifyExtensionToken(token, "wrong-secret")
    expect(verified).toBeNull()
  })

  it("rejects a tampered token", async () => {
    const token = await mintExtensionToken(USER_ID, SECRET)
    // Flip the FIRST character of the signature. It encodes the top 6 bits of
    // the first HMAC byte, so changing it always changes the decoded bytes.
    // (Flipping the LAST character is flaky by construction: a 32-byte HMAC
    // base64-encodes to 43 chars where the final char carries only 4
    // significant bits — swapping it for a char with the same top 4 bits
    // (A↔B↔C↔D) decodes to the IDENTICAL signature and verifies, ~6% of runs.)
    const parts = token.split(".")
    const tamperedSig = (parts[2].startsWith("A") ? "B" : "A") + parts[2].slice(1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`
    const verified = await verifyExtensionToken(tampered, SECRET)
    expect(verified).toBeNull()
  })

  it("rejects an expired token", async () => {
    // ttl of -1 second → already expired.
    const token = await mintExtensionToken(USER_ID, SECRET, -1)
    const verified = await verifyExtensionToken(token, SECRET)
    expect(verified).toBeNull()
  })

  it("rejects malformed tokens (not 3 segments)", async () => {
    expect(await verifyExtensionToken("not-a-jwt", SECRET)).toBeNull()
    expect(await verifyExtensionToken("a.b", SECRET)).toBeNull()
    expect(await verifyExtensionToken("a.b.c.d", SECRET)).toBeNull()
  })

  it("rejects a token with empty subject", async () => {
    // Hand-craft a token whose payload has sub: "" — sign it correctly.
    const header = { alg: "HS256", typ: "JWT" }
    const payload = { sub: "", iat: 0, exp: 9999999999 }
    const enc = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const crypto = await import("node:crypto")
    const key = crypto.createHmac("sha256", SECRET).update(`${enc(header)}.${enc(payload)}`).digest()
    const sig = btoa(String.fromCharCode(...new Uint8Array(key)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const token = `${enc(header)}.${enc(payload)}.${sig}`
    expect(await verifyExtensionToken(token, SECRET)).toBeNull()
  })
})

describe("userIdFromRelayRequest", () => {
  it("extracts userId from a valid ?token= query param", async () => {
    const token = await mintExtensionToken(USER_ID, SECRET)
    const url = new URL(`wss://worker/browser/relay?token=${token}`)
    expect(await userIdFromRelayRequest(url, SECRET)).toBe(USER_ID)
  })

  it("returns null when no token query param is present", async () => {
    const url = new URL("wss://worker/browser/relay")
    expect(await userIdFromRelayRequest(url, SECRET)).toBeNull()
  })

  it("returns null for an invalid token", async () => {
    const url = new URL("wss://worker/browser/relay?token=garbage")
    expect(await userIdFromRelayRequest(url, SECRET)).toBeNull()
  })
})

import { describe, it, expect, beforeEach } from "vitest"

/**
 * Unit tests for the extension pairing flow (src/auth/extension-pairing.ts).
 *
 * These exercise the route handlers directly against a minimal in-memory D1
 * mock (prepare().bind().first()/.run()) rather than the full Workers
 * runtime, mirroring the "fake backing store, real logic" pattern used by
 * db-flow.test.ts. Covers:
 *   1. pair → redeem → refresh happy path.
 *   2. Single-use enforcement (redeeming twice fails the 2nd time).
 *   3. Expired code rejection.
 *   4. Unknown/garbage code rejection.
 *   5. Revoked refresh token rejection.
 *   6. unpair revokes all of a user's refresh tokens.
 */

const {
  createPairingCodeRoute,
  redeemPairingCodeRoute,
  refreshAccessTokenRoute,
  revokeAllRefreshTokensRoute,
} = await import("../auth/extension-pairing")

const USER_ID = "user_abc123"

// ── Minimal in-memory D1 mock ────────────────────────────────────────────
// Enough of the D1Database surface (prepare/bind/first/run) for the two
// tables this module touches. Not a general-purpose SQL engine — just
// pattern-matches the handful of statements extension-pairing.ts issues.
interface Row {
  [key: string]: unknown
}

function createFakeD1() {
  const pairings = new Map<string, Row>()
  const refreshTokens = new Map<string, Row>()

  function prepare(sql: string) {
    let bound: unknown[] = []
    const statement = {
      bind(...args: unknown[]) {
        bound = args
        return statement
      },
      async first<T = Row>(): Promise<T | null> {
        if (sql.includes("FROM extension_pairings")) {
          const code = bound[0] as string
          return (pairings.get(code) as T) ?? null
        }
        if (sql.includes("FROM extension_refresh_tokens")) {
          const hash = bound[0] as string
          return (refreshTokens.get(hash) as T) ?? null
        }
        return null
      },
      async run() {
        if (sql.startsWith("INSERT INTO extension_pairings")) {
          const [code, user_id, created_at, expires_at] = bound as [
            string,
            string,
            number,
            number,
          ]
          pairings.set(code, {
            code,
            user_id,
            created_at,
            expires_at,
            redeemed_at: null,
          })
        } else if (
          sql.startsWith("UPDATE extension_pairings SET redeemed_at")
        ) {
          const [redeemed_at, code] = bound as [number, string]
          const row = pairings.get(code)
          if (row) row.redeemed_at = redeemed_at
        } else if (sql.startsWith("INSERT INTO extension_refresh_tokens")) {
          const [token_hash, user_id, created_at] = bound as [
            string,
            string,
            number,
          ]
          refreshTokens.set(token_hash, {
            token_hash,
            user_id,
            created_at,
            last_used_at: null,
            revoked_at: null,
          })
        } else if (
          sql.startsWith("UPDATE extension_refresh_tokens SET last_used_at")
        ) {
          const [last_used_at, token_hash] = bound as [number, string]
          const row = refreshTokens.get(token_hash)
          if (row) row.last_used_at = last_used_at
        } else if (
          sql.startsWith("UPDATE extension_refresh_tokens SET revoked_at")
        ) {
          const [revoked_at, user_id] = bound as [number, string]
          let count = 0
          for (const row of refreshTokens.values()) {
            if (row.user_id === user_id && !row.revoked_at) {
              row.revoked_at = revoked_at
              count++
            }
          }
          return { meta: { rows_written: count } } as any
        }
        return { meta: { rows_written: 1 } } as any
      },
    }
    return statement
  }

  return { prepare, _pairings: pairings, _refreshTokens: refreshTokens }
}

function fakeContext(fakeDb: any, userId?: string, body?: unknown) {
  return {
    env: { DB: fakeDb, AUTH_SECRET: "test-secret-32-bytes-long-aaaaaa" },
    get(key: string) {
      if (key === "userId") return userId
      return undefined
    },
    req: {
      async json() {
        return body ?? {}
      },
    },
    json(data: unknown, status?: number) {
      return { status: status ?? 200, body: data }
    },
  } as any
}

describe("extension pairing — happy path", () => {
  let env: ReturnType<typeof createFakeD1>

  beforeEach(() => {
    env = createFakeD1()
  })

  it("pair → redeem → refresh round-trips to a usable access token", async () => {
    const pairRes = await createPairingCodeRoute(fakeContext(env, USER_ID))
    expect(pairRes.status).toBe(200)
    const { code, expiresIn } = pairRes.body as {
      code: string
      expiresIn: number
    }
    expect(typeof code).toBe("string")
    expect(code.length).toBe(6)
    expect(expiresIn).toBe(5 * 60)

    const redeemRes = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code }),
    )
    expect(redeemRes.status).toBe(200)
    const { refreshToken, accessToken, accessTokenExpiresIn } =
      redeemRes.body as {
        refreshToken: string
        accessToken: string
        accessTokenExpiresIn: number
      }
    expect(typeof refreshToken).toBe("string")
    expect(typeof accessToken).toBe("string")
    expect(accessTokenExpiresIn).toBe(60 * 60)

    const refreshRes = await refreshAccessTokenRoute(
      fakeContext(env, undefined, { refreshToken }),
    )
    expect(refreshRes.status).toBe(200)
    expect(typeof (refreshRes.body as any).accessToken).toBe("string")
  })

  it("rejects redeeming the same code twice (single-use)", async () => {
    const pairRes = await createPairingCodeRoute(fakeContext(env, USER_ID))
    const { code } = pairRes.body as { code: string }

    const first = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code }),
    )
    expect(first.status).toBe(200)

    const second = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code }),
    )
    expect(second.status).toBe(400)
    expect((second.body as any).error).toMatch(/already used/i)
  })

  it("rejects an expired pairing code", async () => {
    const pairRes = await createPairingCodeRoute(fakeContext(env, USER_ID))
    const { code } = pairRes.body as { code: string }
    // Force expiry by rewriting the stored row directly.
    const row = (env as any)._pairings.get(code)
    row.expires_at = Date.now() - 1000

    const res = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code }),
    )
    expect(res.status).toBe(400)
    expect((res.body as any).error).toMatch(/expired/i)
  })

  it("rejects an unknown code", async () => {
    const res = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code: "ZZZZZZ" }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects a missing code", async () => {
    const res = await redeemPairingCodeRoute(fakeContext(env, undefined, {}))
    expect(res.status).toBe(400)
  })

  it("rejects refresh with a revoked token", async () => {
    const pairRes = await createPairingCodeRoute(fakeContext(env, USER_ID))
    const { code } = pairRes.body as { code: string }
    const redeemRes = await redeemPairingCodeRoute(
      fakeContext(env, undefined, { code }),
    )
    const { refreshToken } = redeemRes.body as { refreshToken: string }

    const unpairRes = await revokeAllRefreshTokensRoute(
      fakeContext(env, USER_ID),
    )
    expect((unpairRes.body as any).revoked).toBe(1)

    const refreshRes = await refreshAccessTokenRoute(
      fakeContext(env, undefined, { refreshToken }),
    )
    expect(refreshRes.status).toBe(401)
  })

  it("rejects refresh with a garbage token", async () => {
    const res = await refreshAccessTokenRoute(
      fakeContext(env, undefined, { refreshToken: "not-a-real-token" }),
    )
    expect(res.status).toBe(401)
  })
})

// =============================================================================
// RateLimiter — global concurrency/rate gate for the shared LLM key.
// =============================================================================
// WHY A SINGLE GLOBAL DO
// All users share ONE LLM_API_KEY. Its rate limit is per-key, per-deployment —
// not per-user. So 20 users searching at once on the 2-minute cron can trip the
// provider's limit and fail everyone. This DO is the single place that knows
// the global request rate, with per-user buckets so no single user hogs it.
//
// WHAT IT GUARDS
//   1. "llm" — sliding window on model calls across ALL users. Before each
//      model call, the harness calls consume("llm", userId). On limit, the
//      harness sleeps-and-retries or ends the turn gracefully.
//   2. "active-run" — per-user limit of 1 concurrent harness loop. start()
//      checks check("active-run", userId, 1); a second concurrent run is
//      rejected with a clear message.
//
// STORAGE
// SQLite-backed (new_sqlite_classes). The window table holds (key, user_id,
// ts) rows; we prune entries older than the window on each call. Cheap and
// correct for the scale we target (10–100 users).
// =============================================================================
import { Agent, callable } from "agents"
import type { Env } from "../types"
import { execSql } from "../db/db"

interface RateLimiterState {
  initialized: boolean
}

export class RateLimiter extends Agent<Env, RateLimiterState> {
  initialState: RateLimiterState = { initialized: false }

  private ensureDb() {
    // Idempotent — safe to run on every call.
    execSql(
      this as any,
      `CREATE TABLE IF NOT EXISTS rate_window (
        key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`,
    )
    execSql(
      this as any,
      `CREATE INDEX IF NOT EXISTS idx_rate_key_ts ON rate_window (key, ts)`,
    )
    if (!this.state.initialized) {
      this.setState({ ...this.state, initialized: true })
    }
  }

  /**
   * Count how many events for (key, userId) fall within `windowSeconds`. Does
   * NOT add a new event — pure read.
   */
  @callable()
  async check(params: {
    key: string
    userId: string
    windowSeconds: number
  }): Promise<{ count: number }> {
    this.ensureDb()
    const since = Date.now() - params.windowSeconds * 1000
    const rows = execSql(
      this as any,
      `SELECT COUNT(*) as c FROM rate_window
        WHERE key = ? AND user_id = ? AND ts >= ?`,
      [params.key, params.userId, since],
    )
    return { count: Number((rows[0] as any)?.c ?? 0) }
  }

  /**
   * Record one event for (key, userId) at now, then return the post-increment
   * count within the window. Callers compare against their limit.
   */
  @callable()
  async consume(params: {
    key: string
    userId: string
    windowSeconds: number
  }): Promise<{ count: number }> {
    this.ensureDb()
    const now = Date.now()
    const since = now - params.windowSeconds * 1000

    // Prune old entries for this key (keeps the table bounded).
    execSql(
      this as any,
      `DELETE FROM rate_window WHERE key = ? AND ts < ?`,
      [params.key, since],
    )
    // Insert the new event.
    execSql(
      this as any,
      `INSERT INTO rate_window (key, user_id, ts) VALUES (?, ?, ?)`,
      [params.key, params.userId, now],
    )
    // Count events for this user in the window.
    const rows = execSql(
      this as any,
      `SELECT COUNT(*) as c FROM rate_window
        WHERE key = ? AND user_id = ? AND ts >= ?`,
      [params.key, params.userId, since],
    )
    return { count: Number((rows[0] as any)?.c ?? 0) }
  }
}

// ---------------------------------------------------------------------------
// Limits + windows (single source of truth for the harness + start gate).
// ---------------------------------------------------------------------------

/** LLM calls per user per minute. Bounds cost + protects the shared key. */
export const LLM_RATE_LIMIT = { window: 60, max: 30 }
/** One active harness run per user at a time. */
export const ACTIVE_RUN_LIMIT = { window: 60 * 10, max: 1 }

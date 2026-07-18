// =============================================================================
// Per-user Durable Object resolution (multi-tenant).
// =============================================================================
// Every agent DO is resolved BY USER ID — the session user's id from Better
// Auth. There is no shared "main" instance anymore: each user gets an isolated
// brain (Harness), pipeline (JobApplicationAgent), browser LLM loop
// (BrowserAgent), and live Chrome connection (BrowserRelay).
//
// The userId threads through the whole delegation chain:
//   HTTP → Harness(userId) → tool → JobAgent(userId) / BrowserAgent(userId)
//                              → Relay(userId) → that user's Chrome
// So a request can never cross users — the DO name *is* the userId.
//
// Legacy note: the old literal "main" data is orphaned by this change. That's
// acceptable — pre-auth there was only test/dev data in the shared instance.
// =============================================================================
import { getAgentByName } from "agents"
import type { Env } from "../types"
import { Harness } from "../agents/harness"
import type { JobApplicationAgent } from "../agents/job-agent"
import type { BrowserAgent, BrowserRelay } from "../agents/browser-relay"
import type { RateLimiter } from "../agents/rate-limiter"

/** The rate limiter is a SINGLE global instance, always addressed by this name. */
const RATE_LIMITER_ID = "global"

/**
 * Resolve the Harness + JobApplicationAgent for a user. Both are addressed by
 * the same userId so a user's brain and its jobs pipeline stay coupled.
 */
export async function getAgents(env: Env, userId: string) {
  const harness = await getAgentByName<Env, Harness>(env.HARNESS, userId)
  const jobAgent = await getAgentByName<Env, JobApplicationAgent>(
    env.JOB_AGENT,
    userId,
  )
  return { harness, jobAgent }
}

/**
 * Resolve the BrowserAgent + BrowserRelay for a user. The relay holds THAT
 * user's live Chrome connection (bound via the extension token in Stage 4), so
 * it must be addressed by userId too.
 */
export async function getBrowserAgents(env: Env, userId: string) {
  const browserAgent = await getAgentByName<Env, BrowserAgent>(
    env.BROWSER_AGENT,
    userId,
  )
  const relay = await getAgentByName<Env, BrowserRelay>(
    env.BROWSER_RELAY,
    userId,
  )
  return { browserAgent, relay }
}

/**
 * Resolve a single user's harness by id. Used by the cron watchdog, which has
 * no request context and enumerates users from D1 instead.
 */
export async function getHarnessForUser(env: Env, userId: string) {
  return getAgentByName<Env, Harness>(env.HARNESS, userId)
}

// Re-exported for the few call sites that resolve the relay directly (the
// browser-relay WS upgrade + status routes in index.ts, which learn the userId
// from the extension token in Stage 4).
export async function getRelayForUser(env: Env, userId: string) {
  return getAgentByName<Env, BrowserRelay>(env.BROWSER_RELAY, userId)
}

/**
 * Resolve the single global RateLimiter. Always addressed by the fixed name
 * "global" — it guards the shared LLM key across ALL users.
 */
export async function getRateLimiter(env: Env) {
  return getAgentByName<Env, RateLimiter>(env.RATE_LIMITER, RATE_LIMITER_ID)
}

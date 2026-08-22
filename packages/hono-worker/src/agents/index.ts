// =============================================================================
// Barrel for agent Durable Object classes consumed by the Worker entry.
// =============================================================================
export { Harness } from "./harness"
export { JobApplicationAgent, JOB_STATUSES } from "./job-agent"
// Browser capability — reaches login-walled job sites via the user's real
// Chrome (extension relay) or the managed headless Chromium (paid plan).
// Multi-tenant: both are resolved by userId (this.name), so each user gets
// their own isolated browser loop + Chrome connection.
export { BrowserRelay } from "./browser-relay"
export { BrowserAgent } from "./browser-agent"
// Global rate limiter — guards the shared LLM key across all users + enforces
// the per-user active-run limit. Single instance. (Stub until Stage 5.)
export { RateLimiter } from "./rate-limiter"

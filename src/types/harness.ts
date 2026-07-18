// =============================================================================
// Harness runtime state
// =============================================================================

export type HarnessStatus = "idle" | "running" | "paused" | "done" | "error"

/**
 * A structured execution plan. Persisted into `HarnessState.plan` so it:
 *   1. Survives eviction / restart (Cloudflare "planning as a durability
 *      strategy" — the plan is a recovery mechanism, not just a progress view).
 *   2. Lets us answer "are we stuck?" as `currentStep !== prevSnapshot`
 *      instead of fuzzing on identical tool calls.
 *   3. Reconstructs context after a long wait — the plan tells a recovered
 *      invocation where it was, so we don't have to replay every prior turn.
 *
 * Status codes per Cloudflare's long-running-agent example:
 *   pending → in_progress → complete | failed | skipped
 */
export interface PlanStep {
  id: string
  description: string
  status: "pending" | "in_progress" | "complete" | "failed" | "skipped"
  result?: string | null
}

export interface Plan {
  goal: string
  steps: PlanStep[]
  currentStep: number
  createdAt: string
  updatedAt: string
}

export interface HarnessState {
  status: HarnessStatus
  currentStep: number
  maxSteps: number
  // Soft ceiling on cumulative tokens spent per run (LLM + tool steps combined).
  // 0 = unlimited. Sourced from config.tokenBudget; if absent, falls back to
  // env.MAX_STEPS (kept for backwards compatibility with pre-token-budget deploys).
  tokenBudget: number
  tokensUsed: number
  goal: string
  runId: string | null
  lastRunAt: string | null
  lastError: string | null
  // v2 durability: the active plan. Persisted across evictions so we can
  // resume from where we left off and decide "stuck?" by checking plan
  // progress rather than tool-call patterns.
  plan: Plan | null
  // Multi-tenant: the owning user's id. Set on start() from the session user.
  // The harness DO's NAME is the userId; this stores it so the delegating tools
  // (discover_jobs, write_cover_letter, browser_*) can resolve THEIR sub-agents
  // by the same user — keeping the whole delegation chain within one user.
  userId: string | null
}

export const DEFAULT_HARNESS_STATE: HarnessState = {
  status: "idle",
  currentStep: 0,
  maxSteps: 100,
  tokenBudget: 128000, // 128k tokens
  tokensUsed: 0,
  goal: "Research AI trends and apply to relevant software/AI engineering roles",
  runId: null,
  lastRunAt: null,
  lastError: null,
  plan: null,
  userId: null,
}

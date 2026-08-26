// =============================================================================
// Harness runtime state — pure types (shared between worker + frontend).
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
  /** STANDING goal — the user's job-search mission. Owned by the operator:
   *  edited only via Settings/PUT /api/config (or bootstrapped once when
   *  empty). One-off run goals ("Apply with agent") must NEVER overwrite it. */
  goal: string
  /** The current/last run's task. A one-off goal (apply runs) or a copy of
   *  the standing goal for scheduled/dashboard runs. Null before any run. */
  runGoal: string | null
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
  // "Apply with agent" runs: the job this run is assisting an application
  // for. When the run finishes successfully (the model calls `finish`), the
  // harness deterministically moves this job to "applied" — prompt guidance
  // alone proved unreliable for this transition.
  applyJobId: number | null
}

// =============================================================================
// Harness runtime state
// =============================================================================

export type HarnessStatus = "idle" | "running" | "paused" | "done" | "error"

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
}

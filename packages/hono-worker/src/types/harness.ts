// =============================================================================
// Harness runtime state — the runtime DEFAULT value (Workers-side).
// =============================================================================
// The TYPES (HarnessStatus / PlanStep / Plan / HarnessState) moved to
// @agent-harness/shared-types so the frontend can import them too. Only the
// runtime `const` value stays here — it's a real value (not a type), so it
// can't cross into a type-only package.
import type { HarnessState } from "@agent-harness/shared-types"
export type { HarnessStatus, PlanStep, Plan, HarnessState } from "@agent-harness/shared-types"

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

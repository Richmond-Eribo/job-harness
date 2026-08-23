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
  // No hardcoded goal: an empty goal triggers profile-grounded resolution at
  // run start (synthesizeGoalFromCapabilities → deriveDefaultGoal), so the
  // goal always reflects THIS user's target roles/locations — never a baked-in
  // assumption about what kind of roles they want.
  goal: "",
  runId: null,
  lastRunAt: null,
  lastError: null,
  plan: null,
  userId: null,
}

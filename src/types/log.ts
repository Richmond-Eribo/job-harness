// =============================================================================
// Step log + daily summary types
// =============================================================================

export interface StepLogEntry {
  id: number
  runId: string
  stepNumber: number
  action: string
  input: string | null
  output: string | null
  agent: "harness" | "research" | "job"
  tokensUsed: number | null
  // v2 trace fields — NULL on legacy rows written before the migration.
  reasoning: string | null
  text: string | null
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  durationMs: number | null
  model: string | null
  warnings: string[] // empty array on legacy rows
  createdAt: string
}

export interface DailySummary {
  id: number
  runId: string
  date: string
  goal: string
  focus: string
  summary: string
  decisions: string[]
  stepsTaken: number
  createdAt: string
}

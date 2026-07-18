// =============================================================================
// Step log + daily summary types
// =============================================================================

export interface StepLogEntry {
  id: number
  runId: string
  stepNumber: number | null
  action: string
  input: string | null
  output: string | null
  // Which agent emitted the step. Widened to a free string so new agents
  // (browser-agent, etc.) don't require a type edit every time.
  agent: string
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

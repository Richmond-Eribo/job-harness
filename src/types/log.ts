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

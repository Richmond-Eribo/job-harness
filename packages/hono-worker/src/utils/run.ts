// =============================================================================
// Miscellaneous pure helpers shared across agents
// =============================================================================

/** Generate a short, sortable, unique-ish run ID (e.g. run-20260710-a3f2k9). */
export function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const rand = Math.random().toString(36).slice(2, 8)
  return `run-${date}-${rand}`
}

/**
 * Inspect a single-step generateText result to surface what the agent did
 * this turn (tool name + args + tool output) for logging and loop guards.
 */
export function summarizeStep(result: any): {
  toolName: string
  toolArgs: string
  toolOutput: string | null
} {
  const steps: any[] = result?.steps ?? []
  for (const step of steps) {
    const calls: any[] = step?.toolCalls ?? []
    if (calls.length > 0) {
      const c = calls[0]
      return {
        toolName: c.toolName ?? "",
        toolArgs: c.args ? JSON.stringify(c.args) : "",
        toolOutput:
          step.toolResults?.[0]?.result != null
            ? JSON.stringify(step.toolResults[0].result).slice(0, 4000)
            : null,
      }
    }
  }
  return { toolName: "", toolArgs: "", toolOutput: null }
}

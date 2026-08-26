// =============================================================================
// Tool: finish — the agent ends the run and writes a summary.
// =============================================================================
import { tool } from "ai"
import { z } from "zod"
import type { Harness } from "../agents"

export function makeFinishTool(harness: Harness, runId: string, goal: string) {
  return tool({
    description:
      "End this run and write a summary. Call when the goal is met or you've done all useful work. Summarize concretely: what you found, what you did, what's outstanding.",
    inputSchema: z.object({
      summary: z.string().describe("A concrete, specific summary of this run"),
      decisions: z
        .array(z.string())
        .describe("Key decisions or recommendations from this run"),
    }),
    execute: async ({ summary, decisions }) => {
      // Pass the run's apply target (if any) so "Apply with agent" runs move
      // their job to "applied" on successful completion. Awaited so the
      // status transition + trace event land before the tool returns.
      await harness.finishRunPersisted(
        runId,
        goal,
        summary,
        decisions,
        "finished",
        { applyJobId: harness.state.applyJobId },
      )
      return "Run complete."
    },
  })
}

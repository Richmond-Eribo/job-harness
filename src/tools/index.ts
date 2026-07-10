// =============================================================================
// buildAgentTools — composes every tool the Harness exposes to the LLM.
// =============================================================================
// Each tool lives in its own file (simple things, easy to navigate). This
// aggregator wires them with the closure state they share with the loop:
//   - advance: bump the step counter + log the call (for step visibility)
// =============================================================================
import type { Env } from "../types"
import { makeResearchTool } from "./research.tool"
import {
  makeDiscoverJobsTool,
  makeWriteCoverLetterTool,
  makePipelineStatusTool,
  makeListJobsTool,
  makeSetJobStatusTool,
} from "./jobs.tool"
import { makeRememberTool, makeRecallTool } from "./memory.tool"
import { makeFinishTool } from "./finish.tool"
import type { Harness } from "../agents"

export function buildAgentTools(
  harness: Harness,
  env: Env,
  runId: string,
  goal: string,
) {
  const advance = (toolName: string, input: string | null) => {
    harness.advanceForTool(runId, toolName, input)
  }

  return {
    // --- Sub-agent delegation (capability providers) ---
    research: makeResearchTool(env, advance),
    discover_jobs: makeDiscoverJobsTool(env, advance),
    write_cover_letter: makeWriteCoverLetterTool(env, advance),
    pipeline_status: makePipelineStatusTool(env),
    list_jobs: makeListJobsTool(env),
    set_job_status: makeSetJobStatusTool(env),

    // --- Explicit memory (agent chooses what's worth keeping) ---
    remember: makeRememberTool(harness),
    recall: makeRecallTool(harness),

    // --- Termination ---
    finish: makeFinishTool(harness, runId, goal),
  }
}

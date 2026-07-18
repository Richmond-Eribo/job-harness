// =============================================================================
// buildAgentTools — composes every tool the Harness exposes to the LLM.
// =============================================================================
// Each tool lives in its own file (simple things, easy to navigate). This
// aggregator wires them with the closure state they share with the loop:
//   - advance: log the tool call (for step visibility)
//   - userId: the owning user — every sub-agent is resolved BY this id so the
//     whole delegation chain stays within one user's data + browser connection.
// =============================================================================
import type { Env } from "../types"
import {
  makeDiscoverJobsTool,
  makeWriteCoverLetterTool,
  makePipelineStatusTool,
  makeListJobsTool,
  makeSetJobStatusTool,
  makeSaveJobTool,
} from "./jobs.tool"
import { makeRememberTool, makeRecallTool } from "./memory.tool"
import { makeFinishTool } from "./finish.tool"
import {
  makeBrowserNavigateTool,
  makeBrowserObserveTool,
  makeBrowserActTool,
  makeBrowserExtractTool,
  makeBrowserBrowseTool,
} from "./browser.tool"
import type { Harness } from "../agents"

export function buildAgentTools(
  harness: Harness,
  env: Env,
  runId: string,
  goal: string,
  userId: string,
) {
  const advance = (toolName: string, input: string | null) => {
    harness.advanceForTool(runId, toolName, input)
  }

  // A small shared holder for the active run id, so delegating tools can pass
  // it to the sub-agents (which use it to attribute their inner-loop trace).
  // Built fresh per buildAgentTools() call, which happens once per run + once
  // for the planner/synthesizer (with a sentinel id).
  const runIdRef = { value: runId }

  return {
    // --- Sub-agent delegation (capability providers) ---
    // All resolved by userId so they operate on THIS user's data.
    discover_jobs: makeDiscoverJobsTool(env, advance, runIdRef, userId),
    write_cover_letter: makeWriteCoverLetterTool(env, advance, runIdRef, userId),
    pipeline_status: makePipelineStatusTool(env, userId),
    list_jobs: makeListJobsTool(env, userId),
    set_job_status: makeSetJobStatusTool(env, userId),
    // Save a job the agent found while BROWSING into the pipeline.
    save_job: makeSaveJobTool(env, advance, userId),

    // --- Browser capability (login-walled sites) ---
    // These reach the user's real logged-in Chrome via the extension relay, or
    // the managed headless browser. observe() detects login walls and stops.
    // All resolved by userId so they hit THIS user's Chrome connection.
    browser_navigate: makeBrowserNavigateTool(env, advance, userId),
    browser_observe: makeBrowserObserveTool(env, advance, userId),
    browser_act: makeBrowserActTool(env, advance, userId),
    browser_extract: makeBrowserExtractTool(env, advance, runIdRef, userId),
    browser_browse: makeBrowserBrowseTool(env, advance, runIdRef, userId),

    // --- Explicit memory (agent chooses what's worth keeping) ---
    remember: makeRememberTool(harness),
    recall: makeRecallTool(harness),

    // --- Termination ---
    finish: makeFinishTool(harness, runId, goal),
  }
}

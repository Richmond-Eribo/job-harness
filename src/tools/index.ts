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
    research: makeResearchTool(env, advance, runIdRef),
    discover_jobs: makeDiscoverJobsTool(env, advance, runIdRef),
    write_cover_letter: makeWriteCoverLetterTool(env, advance, runIdRef),
    pipeline_status: makePipelineStatusTool(env),
    list_jobs: makeListJobsTool(env),
    set_job_status: makeSetJobStatusTool(env),

    // --- Browser capability (login-walled sites) ---
    // These reach the user's real logged-in Chrome via the extension relay, or
    // the managed headless browser. observe() detects login walls and stops.
    browser_navigate: makeBrowserNavigateTool(env, advance),
    browser_observe: makeBrowserObserveTool(env, advance),
    browser_act: makeBrowserActTool(env, advance),
    browser_extract: makeBrowserExtractTool(env, advance, runIdRef),
    browser_browse: makeBrowserBrowseTool(env, advance, runIdRef),

    // --- Explicit memory (agent chooses what's worth keeping) ---
    remember: makeRememberTool(harness),
    recall: makeRecallTool(harness),

    // --- Termination ---
    finish: makeFinishTool(harness, runId, goal),
  }
}

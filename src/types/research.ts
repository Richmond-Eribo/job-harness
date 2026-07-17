// =============================================================================
// Research domain types
// =============================================================================

export interface ResearchResult {
  id: number
  topic: string
  query: string
  summary: string
  sources: string[] // URLs or references
  depth: "quick" | "standard" | "deep"
  createdAt: string
}

export interface ResearchTopic {
  id: number
  topic: string
  priority: number
  timesResearched: number
  lastResearched: string | null
  status: "active" | "paused" | "completed"
}

export interface ResearchRequest {
  topic: string
  depth?: "quick" | "standard" | "deep"
  context?: string
  /** Harness run id, so the research-agent's inner-loop trace can be attributed. */
  runId?: string
}

export interface ResearchResponse {
  topic: string
  summary: string
  findings: Array<{
    title: string
    summary: string
    source: string
  }>
  newTopicsDiscovered: string[]
  /**
   * Sub-agent inner-loop trace. The harness ingests this into its trace_events
   * (nested under the `research` tool call) so the dashboard can show what the
   * research-agent did. Present only when invoked through the harness tool;
   * standalone API calls (POST /api/research/run) leave it unset.
   */
  __trace?: { agent: string; events: unknown[] }
}

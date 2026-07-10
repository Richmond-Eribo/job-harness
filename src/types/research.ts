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
}

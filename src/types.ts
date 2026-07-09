// =============================================================================
// Shared types for the Agent Harness system
// =============================================================================

// Type-only imports to strongly type the DO namespace generics below.
// These are erased at runtime, so there is no actual circular import.
import type { Harness } from "./harness"
import type { ResearchAgent } from "./research-agent"
import type { JobApplicationAgent } from "./job-agent"

/**
 * Cloudflare Worker environment bindings.
 * Populated from wrangler.jsonc and secrets.
 */
export interface Env {
  // Durable Object namespaces — typed with their DO class so RPC method calls
  // (e.g. `await harness.start()`) are checked by the compiler.
  HARNESS: DurableObjectNamespace<Harness>
  RESEARCH_AGENT: DurableObjectNamespace<ResearchAgent>
  JOB_AGENT: DurableObjectNamespace<JobApplicationAgent>

  // Secrets only — model identity + provider + generation params live in
  // src/llm-config.json (tunable, version-controlled). Env keeps the API key
  // plus runtime knobs that DON'T make sense in a static config (DO tokens).
  LLM_API_KEY: string
  MAX_STEPS: string
  DASHBOARD_TOKEN: string
}

// =============================================================================
// Harness State
// =============================================================================

export type HarnessStatus = "idle" | "running" | "paused" | "done" | "error"

export interface HarnessState {
  status: HarnessStatus
  currentStep: number
  maxSteps: number
  // Soft ceiling on cumulative tokens spent per run (LLM + tool steps combined).
  // 0 = unlimited. Sourced from config.tokenBudget; if absent, falls back to
  // env.MAX_STEPS (kept for backwards compatibility with pre-token-budget deploys).
  tokenBudget: number
  tokensUsed: number
  goal: string
  runId: string | null
  lastRunAt: string | null
  lastError: string | null
}

export const DEFAULT_HARNESS_STATE: HarnessState = {
  status: "idle",
  currentStep: 0,
  maxSteps: 100,
  tokenBudget: 0,
  tokensUsed: 0,
  goal: "Research AI trends and apply to relevant software/AI engineering roles",
  runId: null,
  lastRunAt: null,
  lastError: null,
}

// =============================================================================
// Schedule (stored in SQLite, managed from dashboard)
// =============================================================================

export interface ScheduleEntry {
  id: number
  cron: string
  focus: "all" | "research" | "jobs"
  enabled: boolean
  lastTriggeredAt: string | null
  // Derived (not stored): human-readable description + next fire time in UTC.
  // null when the cron expression is invalid (kept for forward-compat with rows
  // created before server-side validation was added).
  description: string | null
  nextFireAt: string | null
}

// =============================================================================
// Research Domain
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

// =============================================================================
// Job Application Domain
// =============================================================================

export type JobStatus =
  | "discovered"
  | "draft"
  | "applied"
  | "interview"
  | "offer"
  | "rejected"

export interface JobListing {
  id: number
  company: string
  title: string
  description: string | null
  url: string | null
  matchScore: number | null
  status: JobStatus
  priority: number
  notes: string | null
  source: "manual" | "auto-discovered"
  createdAt: string
  updatedAt: string
}

export interface CoverLetter {
  id: number
  jobId: number
  version: number
  content: string
  createdAt: string
}

export interface FollowUp {
  id: number
  jobId: number
  dueDate: string
  note: string | null
  completed: boolean
}

export interface UserProfile {
  cv: string | null
  preferences: string | null
  targetRoles: string | null
  targetLocations: string | null
  skills: string | null
}

// =============================================================================
// Inter-agent communication
// =============================================================================

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

export interface JobSearchRequest {
  criteria: string
  maxResults?: number
}

export interface JobSearchResponse {
  newListings: Array<{
    company: string
    title: string
    description: string
    url: string
    matchScore: number
  }>
  pipelineUpdate: {
    total: number
    byStatus: Record<JobStatus, number>
    dueFollowUps: number
  }
}

export interface CoverLetterRequest {
  jobId: number
}

export interface CoverLetterResponse {
  jobId: number
  company: string
  title: string
  coverLetter: string
  version: number
}

// =============================================================================
// Step log entry
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

// =============================================================================
// Daily summary
// =============================================================================

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

// =============================================================================
// Barrel re-export of every domain type.
// Importing from "./types" keeps call-sites import-path-stable regardless of
// how the type definitions are split across files.
// =============================================================================

export type { Env } from "./env"

export type { HarnessStatus, HarnessState, Plan, PlanStep } from "./harness"
export { DEFAULT_HARNESS_STATE } from "./harness"

export type { ScheduleEntry } from "./schedule"

export type {
  ResearchResult,
  ResearchTopic,
  ResearchRequest,
  ResearchResponse,
} from "./research"

export type {
  JobStatus,
  JobListing,
  JobSource,
  CoverLetter,
  FollowUp,
  UserProfile,
  JobSearchRequest,
  JobSearchResponse,
  CoverLetterRequest,
  CoverLetterResponse,
} from "./job"

export type { StepLogEntry, DailySummary } from "./log"

export type {
  TraceEvent,
  TraceEventInput,
  TraceEventType,
  TraceAgent,
  SubAgentTrace,
} from "./trace"

export type { UserMemory } from "./memory"

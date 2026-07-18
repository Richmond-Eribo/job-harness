// =============================================================================
// Frontend re-export of the shared browser-safe types.
// =============================================================================
// These types live in @agent-harness/shared-types (a workspace package), which
// formalizes the old cross-folder re-export of the backend's src/types/shared.
// All exports are `import type` — erased at compile time, zero runtime cost, no
// Cloudflare Workers code enters the browser bundle.
//
// Usage in frontend code:
//   import type { JobListing, JobStatus } from "@/types"
//   import type { TraceEventInput } from "@/types"
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
  TraceAgent,
  TraceEventType,
  TraceEvent,
  TraceEventInput,
  SubAgentTrace,
  StepLogEntry,
  DailySummary,
  UserMemory,
  ScheduleEntry,
  HarnessStatus,
  HarnessState,
  Plan,
  PlanStep,
} from "@agent-harness/shared-types"

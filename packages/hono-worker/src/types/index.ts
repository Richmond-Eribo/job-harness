// =============================================================================
// Barrel re-export of every domain type the worker uses.
// =============================================================================
// Domain types (job/trace/log/memory/schedule/harness) live in
// @agent-harness/shared-types now (shared with the frontend). This barrel
// re-exports them so existing `import { ... } from "./types"` call-sites in
// the worker source keep working unchanged. Two things stay WORKERS-ONLY and
// are re-exported from their local files:
//   - Env              (references DurableObjectNamespace/D1Database/R2Bucket)
//   - DEFAULT_HARNESS_STATE (a runtime `const` value, not a type)

export type { Env } from "./env"

// Domain types — re-exported from the shared-types package.
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
  TraceEvent,
  TraceEventInput,
  TraceEventType,
  TraceAgent,
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

// Runtime value — stays in the worker (types live in shared-types).
export { DEFAULT_HARNESS_STATE } from "./harness"

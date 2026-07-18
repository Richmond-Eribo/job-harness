// =============================================================================
// Browser-safe shared types — the import surface for the Vite frontend.
// =============================================================================
// This barrel re-exports ONLY the pure-type files that are safe to import in a
// browser/Vite context. It deliberately EXCLUDES:
//   - index.ts (the backend barrel re-exports `Env` + a runtime `const`)
//   - env.ts (references DurableObjectNamespace / D1Database / R2Bucket —
//     Cloudflare Workers runtime globals from @cloudflare/workers-types)
//   - app-env.ts (transitively depends on `Env`)
//   - harness.ts (exports a runtime `const DEFAULT_HARNESS_STATE` value, not
//     just types — though its types are safe via `import type`)
//
// The frontend imports from here (via the @shared alias or a relative re-export
// in frontend/src/types/index.ts) so changing a domain type in the backend
// breaks the frontend at COMPILE TIME, not runtime. Zero runtime cost — every
// export here is `export type`, fully erased by tsc/esbuild.
// =============================================================================

// job.ts — the job pipeline domain (the frontend's primary data)
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

// trace.ts — the transcript event log
export type {
  TraceAgent,
  TraceEventType,
  TraceEvent,
  TraceEventInput,
  SubAgentTrace,
} from "./trace"

// log.ts — step log + daily summaries
export type { StepLogEntry, DailySummary } from "./log"

// memory.ts — user-authored memory
export type { UserMemory } from "./memory"

// schedule.ts — cron schedules
export type { ScheduleEntry } from "./schedule"

// =============================================================================
// @agent-harness/shared-types — browser-safe types shared by the worker + SPA.
// =============================================================================
// This is the formalized version of what src/types/shared.ts +
// frontend/src/types/index.ts previously faked via cross-folder re-export.
//
// ONLY pure-type files live here — no runtime values, no Cloudflare Workers
// runtime globals (DurableObjectNamespace / D1Database / R2Bucket). Both the
// worker and the Vite frontend import from here, so changing a domain type
// breaks the other side at COMPILE TIME, not runtime. Zero runtime cost —
// every export is `export type`, fully erased by tsc/esbuild.
//
// What stays OUT (Workers-runtime-bound, lives in hono-worker):
//   - Env (env.ts)        — references DurableObjectNamespace / D1Database / R2Bucket
//   - AppEnv (app-env.ts) — transitively depends on Env
//   - DEFAULT_HARNESS_STATE — a runtime `const` value (the TYPE moves here;
//     the value stays in hono-worker and imports the type back).

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

export type {
  TraceAgent,
  TraceEventType,
  TraceEvent,
  TraceEventInput,
  SubAgentTrace,
} from "./trace"

export type { StepLogEntry, DailySummary } from "./log"

export type { UserMemory } from "./memory"

export type { ScheduleEntry } from "./schedule"

export type { HarnessStatus, PlanStep, Plan, HarnessState } from "./harness"

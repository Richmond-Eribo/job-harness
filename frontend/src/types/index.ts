// =============================================================================
// Frontend re-export of the backend's browser-safe shared types.
// =============================================================================
// This file bridges the frontend to the backend's `src/types/shared.ts` barrel.
// All exports are `import type` — erased at compile time, zero runtime cost, no
// Cloudflare Workers code enters the browser bundle.
//
// Usage in frontend code:
//   import type { JobListing, JobStatus } from "@/types"
//   import type { TraceEventInput } from "@/types"
//
// The relative path `../../../src/types/shared` crosses the frontend/ → src/
// boundary within the same repo. The @shared alias in tsconfig.json makes this
// resolvable without relying on include scope.
// =============================================================================
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
} from "../../../src/types/shared"

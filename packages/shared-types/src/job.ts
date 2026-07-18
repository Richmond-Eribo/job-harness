// =============================================================================
// Job application domain types
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
  // Widened from the v1 union ("manual" | "auto-discovered") so site-scraped
  // listings can carry the originating job source's name, e.g. "reed",
  // "linkedin", "manual". Kept as a free string because sources are
  // operator-defined at runtime via the `job_sources` table, not enumerated.
  source: string
  createdAt: string
  updatedAt: string
}

/**
 * A user-configured job website. The agent's search tools refuse any URL
 * whose origin doesn't match an enabled row here — this is the runtime
 * guardrail that lets the operator scope the agent to sites they trust.
 */
export interface JobSource {
  id: number
  name: string
  baseUrl: string
  searchUrlTemplate: string
  notes: string | null
  enabled: boolean
  createdAt: string
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
  // --- Personal info (collected during onboarding/signup) ---
  fullName: string | null
  email: string | null
  phone: string | null
  location: string | null
  links: string | null // JSON array: [{type:"linkedin"|"github"|"portfolio", url:string}]
  workAuth: string | null // visa/work-authorization status

  // --- Career seniority & experience ---
  // Free-text-as-string; the agent consumes these via getProfileString, so the
  // raw value flows straight into the search + cover-letter prompts.
  seniority: string | null // "Junior" | "Mid" | "Senior" | "Staff" | "Principal"
  yearsExperience: string | null // number-as-string, e.g. "7"

  // --- Job-seeking preferences ---
  targetRoles: string | null
  targetLocations: string | null
  skills: string | null
  preferences: string | null
  workMode: string | null // "remote" | "hybrid" | "onsite"
  jobSearchStatus: string | null // "actively looking" | "open" | "passive"

  // --- Dedicated profile links (also surfaced; `links` above is the JSON blob) ---
  linkedinUrl: string | null
  githubUrl: string | null
  portfolioUrl: string | null

  // --- CV/résumé (bytes live in R2; this is a metadata pointer) ---
  cv: string | null // JSON: {r2Key, filename, contentType} — NOT base64
  cvFilename: string | null
  cvContentType: string | null
  cvR2Key: string | null
  cvUploadedAt: string | null
}

export interface JobSearchRequest {
  criteria: string
  maxResults?: number
  /** Harness run id, so the job-agent's inner-loop trace can be attributed. */
  runId?: string
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
  /**
   * Sub-agent inner-loop trace. The harness ingests this into its trace_events
   * (nested under the discover_jobs tool call) so the dashboard can show the
   * real browsing the job-agent did. Present only when invoked through the
   * harness tool.
   */
  __trace?: { agent: string; events: unknown[] }
}

export interface CoverLetterRequest {
  jobId: number
  /** Harness run id, so the job-agent's inner-loop trace can be attributed. */
  runId?: string
}

export interface CoverLetterResponse {
  jobId: number
  company: string
  title: string
  coverLetter: string
  version: number
  /** Sub-agent inner-loop trace, nested under the write_cover_letter call. */
  __trace?: { agent: string; events: unknown[] }
}

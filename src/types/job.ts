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

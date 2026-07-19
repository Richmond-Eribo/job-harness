// React Query hooks for the Worker's API resources.
//
// Centralized so every page uses the same cache keys + fetch logic. Polling
// intervals are tuned per resource: status/notifications poll fast during an
// active run; pipeline/jobs poll slower.
//
// TYPES: all generics reference the backend's shared types (via @/types) so a
// change to JobListing / TraceEventInput / etc. in the backend breaks the
// frontend at compile time, not runtime. No more `any`.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import type {
  JobListing,
  JobStatus,
  JobSearchResponse,
  TraceEvent,
  StepLogEntry,
  UserProfile,
  ScheduleEntry,
  UserMemory,
} from "@/types"

// --- Shape mirrors (types the backend returns but doesn't export standalone) ---

/** The pipeline response from GET /api/pipeline. */
interface PipelineResponse {
  listings: JobListing[]
  stats: JobSearchResponse["pipelineUpdate"]
}

/** The harness status from GET /api/status. */
interface HarnessStatus {
  status: "idle" | "running" | "paused" | "done" | "error"
  currentStep?: number
  goal?: string | null
  runId?: string | null
  lastRunAt?: string | null
  tokensUsed?: number
  [k: string]: unknown
}

/** A run summary from GET /api/runs. */
interface RunSummary {
  runId: string
  status?: string
  goal?: string | null
  startedAt?: string | null
}

/** The single-run trace response from GET /api/runs/:runId. */
interface RunTraceResponse {
  run?: RunSummary
  events?: TraceEvent[]
  trace?: TraceEvent[] // legacy field name
}

/** Notifications from GET /api/notifications. */
interface Notification {
  id: number | string
  message: string
  createdAt?: string
  [k: string]: unknown
}

// --- Agent status (the live "is it running" indicator) ---
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<HarnessStatus>("/status"),
    refetchInterval: 5000,
  })
}

// --- Pipeline (jobs grouped by stage) ---
export function usePipeline() {
  return useQuery({
    queryKey: ["pipeline"],
    queryFn: () => api.get<PipelineResponse>("/pipeline"),
    refetchInterval: 10000,
  })
}

// --- Runs (trace list) ---
export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<RunSummary[]>("/runs"),
    refetchInterval: 10000,
  })
}

// --- Single run events (the transcript) ---
export function useRunTrace(runId: string) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunTraceResponse>(`/runs/${runId}`),
    refetchInterval: 3000,
  })
}

// --- Activity log ---
export function useLog() {
  return useQuery({
    queryKey: ["log"],
    queryFn: () => api.get<StepLogEntry[]>("/log"),
  })
}

// --- Profile ---
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => api.get<UserProfile>("/profile"),
  })
}

// --- Notifications ---
export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<Notification[]>("/notifications"),
    refetchInterval: 15000,
  })
}

// --- Schedules ---
export function useSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.get<ScheduleEntry[]>("/schedules"),
  })
}

// --- User memory ---
export function useUserMemory() {
  return useQuery({
    queryKey: ["user-memory"],
    queryFn: () => api.get<UserMemory[]>("/user-memory"),
  })
}

// --- Mutations ---
export function useStartRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (goal?: string) =>
      api.post<{ message: string }>("/start", goal ? { goal } : {}),
    onSuccess: () => {
      // M10: invalidate all queries that depend on run state. The previous
      // code only invalidated ["status"], leaving the Jobs Kanban, the run
      // history list, and the live activity panel stale for up to 10s until
      // their own poll intervals caught up.
      qc.invalidateQueries({ queryKey: ["status"] })
      qc.invalidateQueries({ queryKey: ["pipeline"] })
      qc.invalidateQueries({ queryKey: ["runs"] })
    },
  })
}

export function useStopRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ message: string }>("/stop"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["status"] })
      qc.invalidateQueries({ queryKey: ["pipeline"] })
      qc.invalidateQueries({ queryKey: ["runs"] })
    },
  })
}

export function useSetJobStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { jobId: number; status: JobStatus; notes?: string }) =>
      api.put<string>(`/jobs/${p.jobId}/status`, { status: p.status, notes: p.notes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  })
}

export function useAddJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (job: Record<string, unknown>) =>
      api.post<{ id: number; message: string }>("/jobs", job),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  })
}

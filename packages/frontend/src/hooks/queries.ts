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
  JobSource,
  CoverLetter,
  TailoredCV,
  FollowUp,
  JobSearchResponse,
  TailoredCvResponse,
  CoverLetterResponse,
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

/** The job detail response from GET /api/jobs/:id. */
export interface JobDetailResponse {
  listing: JobListing | null
  coverLetters: CoverLetter[]
  tailoredCvs: TailoredCV[]
  followUps: FollowUp[]
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
export interface RunSummary {
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
export interface Notification {
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
// Polls every 3s while the run is active; stops once it settles.
export function useRunTrace(runId: string) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunTraceResponse>(`/runs/${runId}`),
    refetchInterval: query => {
      const status = query.state.data?.run?.status
      if (status === "done" || status === "error") return false
      return 3000
    },
  })
}

// --- Activity log ---
export function useLog() {
  return useQuery({
    queryKey: ["log"],
    queryFn: () => api.get<StepLogEntry[]>("/log"),
    staleTime: 30_000,
  })
}

// --- Profile ---
// Config data, not real-time. Window focus should never trigger a refetch
// that could fight the ProfilePage edits overlay.
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => api.get<UserProfile>("/profile"),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
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
    staleTime: 60_000,
  })
}

// --- User memory ---
export function useUserMemory() {
  return useQuery({
    queryKey: ["user-memory"],
    queryFn: () => api.get<UserMemory[]>("/user-memory"),
    staleTime: 30_000,
  })
}

// --- Harness runtime / LLM config (GET/PUT /api/config) ---
// Backend returns a flat Record<string,string> with keys like:
//   goal, maxSteps, tokenBudget, tokensUsed (read-only),
//   llmProvider, llmModel, customProviderUrl.
// Only send keys you want to mutate — updateConfig() does partial writes.
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<Record<string, string>>("/config"),
    staleTime: 60_000,
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, string>) =>
      api.put<string>("/config", patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  })
}

// --- Pre-flight ("is the agent actually set up to do anything useful?") ---
// Backs the Overview page's pre-flight checklist banner and the checklist
// modal that opens when POST /api/start returns 428. `missing` entries are
// "cv" | "job-sources" | "browser" — kept as free strings (not a union type)
// so the frontend never needs a matching enum update when the backend adds a
// new requirement.
export interface PreflightStatus {
  ready: boolean
  missing: string[]
}

export function usePreflight() {
  return useQuery({
    queryKey: ["preflight"],
    queryFn: () => api.get<PreflightStatus>("/start/preflight"),
    staleTime: 10_000,
  })
}

// --- Mutations ---
export function useStartRun() {
  const qc = useQueryClient()
  return useMutation({
    // `force: true` skips the server-side pre-flight gate — used when the
    // user explicitly confirms "start anyway" from the checklist modal.
    mutationFn: (opts?: { goal?: string; force?: boolean }) =>
      api.post<{ message: string }>("/start", {
        ...(opts?.goal ? { goal: opts.goal } : {}),
        ...(opts?.force ? { force: true } : {}),
      }),
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
      api.put<string>(`/jobs/${p.jobId}/status`, {
        status: p.status,
        notes: p.notes,
      }),
    // Optimistic move — kanban DnD (and Advance) must feel instant. Cancel
    // in-flight pipeline fetches, move the card in the cache, roll back on
    // error. The server also auto-creates a follow-up on the first
    // "applied" transition; onSettled's invalidation reconciles that.
    onMutate: async p => {
      await qc.cancelQueries({ queryKey: ["pipeline"] })
      const prev = qc.getQueryData<PipelineResponse>(["pipeline"])
      if (prev) {
        const moved = prev.listings.find(j => j.id === p.jobId)
        qc.setQueryData<PipelineResponse>(["pipeline"], {
          ...prev,
          listings: prev.listings.map(j =>
            j.id === p.jobId
              ? {
                  ...j,
                  status: p.status,
                  updatedAt: new Date().toISOString(),
                }
              : j,
          ),
          stats: moved
            ? {
                ...prev.stats,
                byStatus: {
                  ...prev.stats.byStatus,
                  [moved.status]: Math.max(
                    0,
                    (prev.stats.byStatus[moved.status] ?? 1) - 1,
                  ),
                  [p.status]: (prev.stats.byStatus[p.status] ?? 0) + 1,
                },
              }
            : prev.stats,
        })
      }
      return { prev }
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(["pipeline"], ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["pipeline"] })
      qc.invalidateQueries({ queryKey: ["follow-ups"] })
    },
  })
}

// --- Job detail (GET /api/jobs/:id) — backs the /jobs/$jobId detail page. ---
export function useJob(jobId: number | null) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.get<JobDetailResponse>(`/jobs/${jobId}`),
    enabled: jobId != null,
  })
}

export function useUpdateJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: {
      jobId: number
      notes?: string
      priority?: number
    }) => api.put<string>(`/jobs/${p.jobId}`, p),
    onSuccess: (_d, p) => {
      qc.invalidateQueries({ queryKey: ["job", p.jobId] })
      qc.invalidateQueries({ queryKey: ["pipeline"] })
    },
  })
}

export function useDeleteJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: number) => api.del<string>(`/jobs/${jobId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline"] })
      qc.invalidateQueries({ queryKey: ["follow-ups"] })
    },
  })
}

// LLM generation — slow calls, rate-limited server-side (10/min each).
export function useGenerateCoverLetter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: number) =>
      api.post<CoverLetterResponse>(`/jobs/${jobId}/cover-letter`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job"] }),
  })
}

export function useGenerateTailoredCv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: number) =>
      api.post<TailoredCvResponse>(`/jobs/${jobId}/tailored-cv`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job"] })
      qc.invalidateQueries({ queryKey: ["pipeline"] })
    },
  })
}

// --- Follow-ups ---
export function useDueFollowUps() {
  return useQuery({
    queryKey: ["follow-ups"],
    queryFn: () => api.get<FollowUp[]>("/follow-ups"),
    refetchInterval: 60_000,
  })
}

export function useAddFollowUp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: {
      jobId: number
      dueDate: string
      note?: string
    }) => api.post<string>(`/jobs/${p.jobId}/follow-up`, p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["follow-ups"] })
      qc.invalidateQueries({ queryKey: ["job"] })
    },
  })
}

export function useUpdateFollowUp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: {
      followUpId: number
      completed?: boolean
      dueDate?: string
      note?: string
    }) => api.put<string>(`/follow-ups/${p.followUpId}`, p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["follow-ups"] })
      qc.invalidateQueries({ queryKey: ["job"] })
    },
  })
}

export function useDeleteFollowUp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (followUpId: number) =>
      api.del<string>(`/follow-ups/${followUpId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["follow-ups"] })
      qc.invalidateQueries({ queryKey: ["job"] })
    },
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

// --- Job sources CRUD (was: legacy-dashboard-only UI) ---
// Backs the JobsPage "Sources" modal + any future Settings surface.
// Keys are scoped under ["job-sources"] so invalidations are precise.
export function useJobSources() {
  return useQuery({
    queryKey: ["job-sources"],
    queryFn: () => api.get<JobSource[]>("/job-sources"),
    staleTime: 60_000,
  })
}

export function useAddJobSource() {
  const qc = useQueryClient()
  return useMutation({
    // searchUrlTemplate is optional: without it the agent browses the base URL
    // directly, with it the agent fills {query}/{location}/{page} server-side.
    mutationFn: (src: {
      name: string
      baseUrl: string
      searchUrlTemplate?: string | null
      notes?: string
    }) => api.post<{ id: number; message: string }>("/job-sources", src),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-sources"] }),
  })
}

export function useUpdateJobSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: {
      id: number
      patch: Partial<{
        name: string
        baseUrl: string
        searchUrlTemplate?: string | null
        notes: string
        enabled: boolean
      }>
    }) => api.put<string>(`/job-sources/${p.id}`, p.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-sources"] }),
  })
}

export function useDeleteJobSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.del<string>(`/job-sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-sources"] }),
  })
}

// --- Schedules CRUD (was: legacy-dashboard-only UI) ---
// Backs the new Settings → Schedules tab.
export function useAddSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { cron: string; focus?: string }) =>
      api.post<string>("/schedules", { cron: p.cron, focus: p.focus ?? "all" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.del<string>(`/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
}

export function useToggleSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id: number; enabled: boolean }) =>
      api.put<string>(`/schedules/${p.id}/toggle`, { enabled: p.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
}

// --- Browser / extension pairing (GET /api/browser/status, pair/unpair) ---
// Backs the Settings "Browser & Extension" panel — the ONLY place in the app
// that surfaces whether the agent has a live browser target. Polled while
// Settings is open so "Connected" flips promptly once the extension pairs.
export interface BrowserStatus {
  target: "none" | "live" | "managed"
  live: { connected: boolean; connectedAt?: string; userAgent?: string | null }
  managed: { available: boolean }
  sessionId: string | null
  recentEvents: Array<{ at: string; method: string }>
  pendingCalls: number
}

export function useBrowserStatus() {
  return useQuery({
    queryKey: ["browser-status"],
    queryFn: () => api.get<BrowserStatus>("/browser/status"),
    refetchInterval: 15000,
  })
}

export function usePairExtension() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ code: string; expiresIn: number }>("/browser/pair"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["browser-status"] }),
  })
}

export function useDisconnectBrowser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ disconnected: boolean }>("/browser/disconnect"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["browser-status"] }),
  })
}

/** Revokes ALL of this user's extension refresh tokens (every paired browser). */
export function useUnpairAllBrowsers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/browser/unpair"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["browser-status"] }),
  })
}

export function useProbeBrowser() {
  return useMutation({
    mutationFn: (url: string) =>
      api.post<Record<string, unknown>>("/browser/probe", { url }),
  })
}

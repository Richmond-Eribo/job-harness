// React Query hooks for the Worker's API resources.
//
// Centralized so every page uses the same cache keys + fetch logic. Polling
// intervals are tuned per resource: status/notifications poll fast during an
// active run; pipeline/jobs poll slower.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"

// --- Agent status (the live "is it running" indicator) ---
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get("/status"),
    refetchInterval: 5000,
  })
}

// --- Pipeline (jobs grouped by stage) ---
export function usePipeline() {
  return useQuery({
    queryKey: ["pipeline"],
    queryFn: () => api.get("/pipeline"),
    refetchInterval: 10000,
  })
}

// --- Runs (trace list) ---
export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get("/runs"),
    refetchInterval: 10000,
  })
}

// --- Single run events (the transcript) ---
export function useRunTrace(runId: string) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get(`/runs/${runId}`),
    refetchInterval: 3000,
  })
}

// --- Activity log ---
export function useLog() {
  return useQuery({ queryKey: ["log"], queryFn: () => api.get("/log") })
}

// --- Profile ---
export function useProfile() {
  return useQuery({ queryKey: ["profile"], queryFn: () => api.get("/profile") })
}

// --- Notifications ---
export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get("/notifications"),
    refetchInterval: 15000,
  })
}

// --- Mutations ---
export function useStartRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (goal?: string) => api.post("/start", goal ? { goal } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["status"] })
    },
  })
}

export function useStopRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post("/stop"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  })
}

export function useSetJobStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { jobId: number; status: string; notes?: string }) =>
      api.put(`/jobs/${p.jobId}/status`, { status: p.status, notes: p.notes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  })
}

export function useAddJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (job: Record<string, unknown>) => api.post("/jobs", job),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  })
}

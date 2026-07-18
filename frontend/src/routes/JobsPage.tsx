import { usePipeline, useSetJobStatus } from "../hooks/queries"
import type { JobListing, JobStatus } from "@/types"

const COLUMNS: { id: JobStatus; label: string; color: string }[] = [
  { id: "discovered", label: "Discovered", color: "border-t-slate-500" },
  { id: "draft", label: "Draft", color: "border-t-blue-500" },
  { id: "applied", label: "Applied", color: "border-t-amber-500" },
  { id: "interview", label: "Interview", color: "border-t-purple-500" },
  { id: "offer", label: "Offer", color: "border-t-emerald-500" },
  { id: "rejected", label: "Rejected", color: "border-t-red-500" },
]

export function JobsPage() {
  const { data: pipeline, isLoading } = usePipeline()
  const setJobStatus = useSetJobStatus()

  const listings = pipeline?.listings ?? []
  const byStage = (stage: JobStatus) =>
    listings.filter(j => j.status === stage)

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Jobs pipeline</h1>
      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {COLUMNS.map(col => {
            const jobs = byStage(col.id)
            return (
              <div
                key={col.id}
                className={`w-72 shrink-0 bg-ink-900 rounded-xl border-t-4 ${col.color} border border-ink-800`}
              >
                <div className="px-4 py-3 flex items-center justify-between border-b border-ink-800">
                  <span className="text-sm font-semibold">{col.label}</span>
                  <span className="text-xs text-ink-500 bg-ink-800 px-2 py-0.5 rounded-full">
                    {jobs.length}
                  </span>
                </div>
                <div className="p-3 space-y-2 min-h-[100px]">
                  {jobs.map((job: JobListing) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      onAdvance={(status: JobStatus) =>
                        setJobStatus.mutate({ jobId: job.id, status })
                      }
                    />
                  ))}
                  {jobs.length === 0 && (
                    <div className="text-xs text-ink-700 text-center py-4">
                      Empty
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function JobCard({
  job,
  onAdvance,
}: {
  job: JobListing
  onAdvance: (status: JobStatus) => void
}) {
  // Determine the next stage for the "advance" quick action.
  const order: JobStatus[] = ["discovered", "draft", "applied", "interview", "offer"]
  const idx = order.indexOf(job.status)
  const next: JobStatus | null =
    idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null

  return (
    <div className="bg-ink-950 rounded-lg p-3 border border-ink-800 hover:border-ink-700">
      <div className="font-medium text-sm leading-tight mb-1">{job.title}</div>
      <div className="text-xs text-ink-500 mb-2">{job.company}</div>
      {job.matchScore != null && (
        <div className="text-xs text-ink-500 mb-2">
          Match: {(job.matchScore * 100).toFixed(0)}%
        </div>
      )}
      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline block mb-2"
        >
          View posting ↗
        </a>
      )}
      {next && (
        <button
          onClick={() => onAdvance(next)}
          className="text-xs text-ink-400 hover:text-white transition-colors"
        >
          → Move to {next}
        </button>
      )}
    </div>
  )
}

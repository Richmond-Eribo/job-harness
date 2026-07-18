import { usePipeline, useSetJobStatus } from "../hooks/queries"
import type { JobListing, JobStatus } from "@/types"
import { Badge, Button, Card, CardContent, Skeleton } from "@agent-harness/ui"
import { toast } from "sonner"

const COLUMNS: { id: JobStatus; label: string; accent: string }[] = [
  { id: "discovered", label: "Discovered", accent: "border-t-slate-500" },
  { id: "draft", label: "Draft", accent: "border-t-blue-500" },
  { id: "applied", label: "Applied", accent: "border-t-amber-500" },
  { id: "interview", label: "Interview", accent: "border-t-purple-500" },
  { id: "offer", label: "Offer", accent: "border-t-emerald-500" },
  { id: "rejected", label: "Rejected", accent: "border-t-red-500" },
]

export function JobsPage() {
  const { data: pipeline, isLoading } = usePipeline()
  const setJobStatus = useSetJobStatus()

  const listings = pipeline?.listings ?? []
  const byStage = (stage: JobStatus) => listings.filter(j => j.status === stage)

  const advance = (job: JobListing, status: JobStatus) =>
    setJobStatus.mutate(
      { jobId: job.id, status },
      {
        onSuccess: () => toast.success(`Moved to ${status}`),
        onError: (e: any) => toast.error("Couldn't update job", { description: e?.message }),
      },
    )

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Jobs pipeline</h1>
      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {COLUMNS.map(col => (
            <Skeleton key={col.id} className="w-72 shrink-0 h-64 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {COLUMNS.map(col => {
            const jobs = byStage(col.id)
            return (
              <div
                key={col.id}
                className={`w-72 shrink-0 bg-card rounded-xl border-t-4 ${col.accent} border border-border`}
              >
                <div className="px-4 py-3 flex items-center justify-between border-b border-border">
                  <span className="text-sm font-semibold">{col.label}</span>
                  <Badge variant="secondary">{jobs.length}</Badge>
                </div>
                <div className="p-3 flex flex-col gap-2 min-h-[100px]">
                  {jobs.map((job: JobListing) => (
                    <JobCard key={job.id} job={job} onAdvance={status => advance(job, status)} />
                  ))}
                  {jobs.length === 0 && (
                    <div className="text-xs text-muted-foreground/60 text-center py-4">Empty</div>
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
  const next: JobStatus | null = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null

  return (
    <Card className="py-3 hover:border-primary/40 transition-colors">
      <CardContent className="px-3">
        <div className="font-medium text-sm leading-tight mb-1">{job.title}</div>
        <div className="text-xs text-muted-foreground mb-2">{job.company}</div>
        {job.matchScore != null && (
          <div className="text-xs text-muted-foreground mb-2">
            Match: {(job.matchScore * 100).toFixed(0)}%
          </div>
        )}
        {job.url && (
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline block mb-2"
          >
            View posting ↗
          </a>
        )}
        {next && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAdvance(next)}>
            → Move to {next}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

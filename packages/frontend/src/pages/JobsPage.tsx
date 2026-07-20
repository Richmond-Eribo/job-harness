import { useCallback, useMemo, useState } from "react"
import {
  ArrowRight,
  CircleAlert,
  ExternalLink,
  Inbox,
  Search,
} from "lucide-react"
import { usePipeline, useSetJobStatus } from "../hooks/queries"
import type { JobListing, JobStatus } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
} from "@agent-harness/ui"
import { toast } from "sonner"

const COLUMNS: {
  id: JobStatus
  label: string
  accent: string
  dotColor: string
}[] = [
  {
    id: "discovered",
    label: "Discovered",
    accent: "border-t-muted-foreground/40",
    dotColor: "bg-muted-foreground",
  },
  {
    id: "draft",
    label: "Draft",
    accent: "border-t-primary",
    dotColor: "bg-primary",
  },
  {
    id: "applied",
    label: "Applied",
    accent: "border-t-warning",
    dotColor: "bg-warning",
  },
  {
    id: "interview",
    label: "Interview",
    accent: "border-t-violet-400",
    dotColor: "bg-violet-400",
  },
  {
    id: "offer",
    label: "Offer",
    accent: "border-t-success",
    dotColor: "bg-success",
  },
  {
    id: "rejected",
    label: "Rejected",
    accent: "border-t-destructive/60",
    dotColor: "bg-destructive",
  },
]

export function JobsPage() {
  const { data: pipeline, isLoading, isError, error, refetch } = usePipeline()
  const setJobStatus = useSetJobStatus()
  const [searchQuery, setSearchQuery] = useState("")

  const listings = pipeline?.listings ?? []

  // Lowercase the query once per searchQuery change, not per job.
  const searchLower = useMemo(() => searchQuery.toLowerCase(), [searchQuery])

  // By-stage grouping is a single memoized pass over the filtered list.
  const byStage = useMemo(() => {
    const map: Record<JobStatus, JobListing[]> = {
      discovered: [],
      draft: [],
      applied: [],
      interview: [],
      offer: [],
      rejected: [],
    }
    for (const j of listings) {
      if (searchLower) {
        const title = j.title.toLowerCase()
        const company = j.company.toLowerCase()
        if (!title.includes(searchLower) && !company.includes(searchLower))
          continue
      }
      if (map[j.status]) map[j.status].push(j)
    }
    return map
  }, [listings, searchLower])

  // Stable handler — only closes over setJobStatus (stable).
  const advance = useCallback(
    (job: JobListing, status: JobStatus) =>
      setJobStatus.mutate(
        { jobId: job.id, status },
        {
          onSuccess: () => toast.success(`Moved job to ${status}`),
          onError: (e: { message?: string }) =>
            toast.error("Couldn't update job status", {
              description: e?.message,
            }),
        },
      ),
    [setJobStatus],
  )

  return (
    <div className="p-8 space-y-6 animate-fade-in flex flex-col h-full">
      {/* Header & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Jobs Kanban Pipeline
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your application stages and move positions through the
            funnel.
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="size-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Search title or company…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Kanban Board Columns */}
      {isError ? (
        <Card className="border-destructive/40 bg-destructive/5 flex-1">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load jobs pipeline</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as { message?: string })?.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1">
          {COLUMNS.map(col => (
            <Skeleton key={col.id} className="w-80 shrink-0 h-96 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 items-start">
          {COLUMNS.map((col, colIdx) => {
            const jobs = byStage[col.id]
            return (
              <div
                key={col.id}
                className={`w-80 shrink-0 bg-card rounded-xl border-t-2 ${col.accent} border border-border flex flex-col max-h-full animate-slide-up stagger-child`}
                style={{ "--stagger-i": colIdx } as React.CSSProperties}
              >
                {/* Column Sticky Header */}
                <div className="bg-card px-4 py-3.5 flex items-center justify-between border-b border-border rounded-t-xl shrink-0">
                  <span className="text-sm font-semibold flex items-center gap-2">
                    <span className={`size-2 rounded-full ${col.dotColor}`} />
                    {col.label}
                  </span>
                  <Badge
                    variant="secondary"
                    className="font-mono text-xs px-2 py-0.5"
                  >
                    {jobs.length}
                  </Badge>
                </div>

                {/* Cards Container */}
                <div className="p-3 flex flex-col gap-2.5 overflow-y-auto min-h-[160px]">
                  {jobs.map((job: JobListing) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      onAdvance={status => advance(job, status)}
                    />
                  ))}
                  {jobs.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground/40 border border-dashed border-border/60 rounded-lg">
                      <Inbox className="size-6 mb-2" />
                      <span className="text-xs">No positions</span>
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
  const order: JobStatus[] = [
    "discovered",
    "draft",
    "applied",
    "interview",
    "offer",
  ]
  const idx = order.indexOf(job.status)
  const next: JobStatus | null =
    idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null
  const score = job.matchScore != null ? Math.round(job.matchScore * 100) : null

  return (
    <Card className="py-3 px-3.5 transition-all duration-150 hover:border-primary/40 shadow-sm">
      <CardContent className="p-0 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold text-sm leading-snug text-foreground">
            {job.title}
          </div>
          {score != null && (
            <Badge
              variant="secondary"
              className="font-mono text-[11px] shrink-0 bg-primary/10 text-primary border-primary/20"
            >
              {score}%
            </Badge>
          )}
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          {job.company}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-border/60">
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              Link <ExternalLink className="size-3" />
            </a>
          ) : (
            <span />
          )}

          {next && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onAdvance(next)}
            >
              Advance <ArrowRight className="size-3 ml-1" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

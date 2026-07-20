import { useStatus, usePipeline, useStartRun, useStopRun } from "../hooks/queries"
import type { JobListing } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@agent-harness/ui"
import { toast } from "sonner"
import {
  Briefcase,
  PlayCircle,
  StopCircle,
  Search,
  TrendingUp,
  AlertCircle,
  ArrowUpRight,
  CircleAlert,
} from "lucide-react"

const STAGES = [
  "discovered",
  "draft",
  "applied",
  "interview",
  "offer",
  "rejected",
] as const

const STAGE_ACCENT: Record<string, string> = {
  discovered: "border-t-muted-foreground/40",
  draft: "border-t-primary",
  applied: "border-t-warning",
  interview: "border-t-violet-400",
  offer: "border-t-success",
  rejected: "border-t-destructive/60",
}

export function OverviewPage() {
  const {
    data: status,
    isLoading: statusLoading,
    isError: statusErr,
    error: statusErrObj,
    refetch: refetchStatus,
  } = useStatus()
  const {
    data: pipeline,
    isLoading: pipelineLoading,
    isError: pipelineErr,
    error: pipelineErrObj,
    refetch: refetchPipeline,
  } = usePipeline()
  const startRun = useStartRun()
  const stopRun = useStopRun()

  const isRunning = status?.status === "running"
  const stats = pipeline?.stats ?? {
    total: 0,
    byStatus: {} as Partial<Record<string, number>>,
    dueFollowUps: 0,
  }
  const listings = pipeline?.listings ?? []

  const handleStart = () =>
    startRun.mutate(undefined, {
      onSuccess: () => toast.success("Agent run initiated"),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't start the agent", { description: e?.message }),
    })
  const handleStop = () =>
    stopRun.mutate(undefined, {
      onSuccess: () => toast.success("Agent run stopped"),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't stop the agent", { description: e?.message }),
    })

  // Failure state — render error card with retry instead of misleading empty state.
  if (statusErr || pipelineErr) {
    const msg =
      (statusErr
        ? (statusErrObj as { message?: string })?.message
        : (pipelineErrObj as { message?: string })?.message) ?? "Unknown error"
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load pipeline data</p>
            <p className="text-xs text-muted-foreground mt-1">{msg}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                if (statusErr) refetchStatus()
                if (pipelineErr) refetchPipeline()
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-fade-in">
      {/* Overview Top Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Pipeline Overview
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time status of your autonomous job search and application
            pipeline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {statusLoading ? (
            <Skeleton className="h-9 w-28 rounded-lg" />
          ) : isRunning ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleStop}
              disabled={stopRun.isPending}
            >
              <StopCircle className="size-4 mr-1.5" />
              {stopRun.isPending ? "Stopping…" : "Stop Agent"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleStart}
              disabled={startRun.isPending}
            >
              <PlayCircle className="size-4 mr-1.5" />
              {startRun.isPending ? "Starting…" : "Start Agent Run"}
            </Button>
          )}
        </div>
      </div>

      {/* 6 Stage Breakdown Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {STAGES.map((stage, i) => (
          <Card
            key={stage}
            className={`py-3.5 border-t-2 ${STAGE_ACCENT[stage]} animate-slide-up stagger-child`}
            style={{ "--stagger-i": i } as React.CSSProperties}
          >
            <CardContent className="px-4">
              <div className="text-xs text-muted-foreground capitalize font-medium mb-1">
                {stage}
              </div>
              {pipelineLoading ? (
                <Skeleton className="h-8 w-10" />
              ) : (
                <div className="text-2xl font-bold font-mono tabular-nums tracking-tight">
                  {stats.byStatus?.[stage] ?? 0}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Split Grid: 2/3 Left (Listings Feed) & 1/3 Right (Control & Tasks) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Recent Job Discoveries */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Briefcase className="size-4 text-primary" />
              Recent Job Listings
            </h2>
            <span className="text-xs text-muted-foreground font-mono">
              {listings.length} discovered listings
            </span>
          </div>

          {pipelineLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : listings.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-16 text-center">
                <Search className="size-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm font-medium text-foreground">
                  No job listings discovered yet
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  Click "Start Agent Run" to begin scanning your allowlisted job
                  boards for relevant positions.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {listings.slice(0, 8).map((job: JobListing, i: number) => {
                const score =
                  job.matchScore != null
                    ? Math.round(job.matchScore * 100)
                    : null
                return (
                  <Card
                    key={job.id}
                    className="py-3.5 px-4 transition-all duration-150 hover:border-primary/40 animate-slide-up stagger-child"
                    style={{ "--stagger-i": i } as React.CSSProperties}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-sm text-foreground truncate">
                            {job.title}
                          </h3>
                          <Badge
                            variant="secondary"
                            className="capitalize text-[11px] font-medium shrink-0"
                          >
                            {job.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {job.company}
                        </p>
                      </div>

                      {score != null && (
                        <div className="text-right shrink-0">
                          <div className="text-xs font-mono font-semibold text-foreground">
                            {score}%{" "}
                            <span className="text-[10px] text-muted-foreground font-sans">
                              match
                            </span>
                          </div>
                          <div className="w-16 bg-secondary h-1.5 rounded-full mt-1.5 overflow-hidden">
                            <div
                              className="bg-primary h-full rounded-full transition-all"
                              style={{ width: `${score}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </Card>
                )
              })}
            </div>
          )}
        </div>

        {/* Right Column: Status Summary & Actions */}
        <div className="space-y-6">
          {/* Agent Status Panel */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="size-4 text-primary" />
                Agent Status & Control
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-secondary/40 rounded-lg border border-border">
                <span className="text-xs text-muted-foreground">
                  Execution State
                </span>
                <span className="inline-flex items-center gap-2 text-xs font-medium capitalize text-foreground">
                  <span
                    className={`size-2 rounded-full ${
                      isRunning
                        ? "bg-success animate-pulse"
                        : "bg-muted-foreground/40"
                    }`}
                  />
                  {status?.status ?? "Idle"}
                </span>
              </div>

              <div className="text-xs text-muted-foreground space-y-2">
                <div className="flex items-center justify-between">
                  <span>Target Boards</span>
                  <span className="text-foreground font-mono">
                    HN, LinkedIn
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Auto Cover Letters</span>
                  <span className="text-success font-medium">Enabled</span>
                </div>
              </div>

              {isRunning ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  onClick={handleStop}
                >
                  Stop Active Run
                </Button>
              ) : (
                <Button size="sm" className="w-full" onClick={handleStart}>
                  Trigger New Search Run
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Action Required Card */}
          {!pipelineLoading && stats.dueFollowUps > 0 && (
            <Card className="border-l-4 border-l-warning">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-warning">
                  <AlertCircle className="size-4" />
                  Follow-ups Pending
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-2">
                <p>
                  You have{" "}
                  <strong className="text-foreground">
                    {stats.dueFollowUps}
                  </strong>{" "}
                  job application follow-up(s) waiting for review.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-2"
                  asChild
                >
                  <a href="/jobs">
                    Review on Board <ArrowUpRight className="size-3 ml-1" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

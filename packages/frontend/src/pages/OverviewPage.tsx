import { useStatus, usePipeline, useStartRun, useStopRun } from "../hooks/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@agent-harness/ui"
import { toast } from "sonner"

const STAGES = [
  "discovered",
  "draft",
  "applied",
  "interview",
  "offer",
  "rejected",
] as const

export function OverviewPage() {
  const { data: status, isLoading: statusLoading } = useStatus()
  const { data: pipeline, isLoading: pipelineLoading } = usePipeline()
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
      onSuccess: () => toast.success("Agent started"),
      onError: (e: any) => toast.error("Couldn't start the agent", { description: e?.message }),
    })
  const handleStop = () =>
    stopRun.mutate(undefined, {
      onSuccess: () => toast.success("Agent stopped"),
      onError: (e: any) => toast.error("Couldn't stop the agent", { description: e?.message }),
    })

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="flex items-center gap-3">
          {statusLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <span
                className={`size-2 rounded-full ${
                  isRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/40"
                }`}
              />
              {status?.status ?? "idle"}
            </span>
          )}
          {isRunning ? (
            <Button variant="destructive" size="sm" onClick={handleStop} disabled={stopRun.isPending}>
              {stopRun.isPending ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={startRun.isPending}>
              {startRun.isPending ? "Starting…" : "Start run"}
            </Button>
          )}
        </div>
      </div>

      {/* Stage breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {STAGES.map(stage => (
          <Card key={stage} className="py-4">
            <CardContent className="px-4">
              {pipelineLoading ? (
                <Skeleton className="h-8 w-8" />
              ) : (
                <div className="text-2xl font-bold">{stats.byStatus?.[stage] ?? 0}</div>
              )}
              <div className="text-xs text-muted-foreground capitalize mt-0.5">{stage}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Due follow-ups summary */}
      {!pipelineLoading && stats.dueFollowUps > 0 && (
        <Card className="mb-6 py-4 border-primary/40">
          <CardContent className="px-4 flex items-center gap-3">
            <Badge variant="default">{stats.dueFollowUps}</Badge>
            <span className="text-sm text-muted-foreground">
              follow-up{stats.dueFollowUps === 1 ? "" : "s"} due — review them on the Jobs board.
            </span>
          </CardContent>
        </Card>
      )}

      {/* Recent jobs */}
      <h2 className="text-lg font-semibold mb-3">
        Recent jobs{" "}
        <span className="text-sm text-muted-foreground font-normal">({listings.length} total)</span>
      </h2>
      {pipelineLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : listings.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No jobs yet. Start a run to discover listings.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {listings.slice(0, 10).map((job: any) => (
            <Card key={job.id} className="py-3 hover:border-primary/40 transition-colors">
              <CardContent className="px-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{job.title}</div>
                  <div className="text-sm text-muted-foreground truncate">{job.company}</div>
                </div>
                <Badge variant="secondary" className="capitalize">{job.status}</Badge>
                {job.matchScore != null && (
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {(job.matchScore * 100).toFixed(0)}%
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

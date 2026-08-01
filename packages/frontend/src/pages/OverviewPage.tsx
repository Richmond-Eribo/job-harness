import { useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  useStatus,
  usePipeline,
  useStartRun,
  useStopRun,
  usePreflight,
} from "../hooks/queries"
import type { JobListing } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
  FileText,
  Globe,
  Chrome,
} from "lucide-react"

// Pre-flight requirement metadata — mirrors the `missing` string keys the
// backend's computePreflightGaps() emits (src/index.ts). Kept as a lookup
// here rather than a shared enum so the UI can degrade gracefully (an
// unrecognized key still renders, just without an icon/link) if the backend
// ever adds a new requirement before the frontend catches up.
const PREFLIGHT_ITEMS: Record<
  string,
  { label: string; hint: string; to: string; icon: typeof FileText }
> = {
  cv: {
    label: "Upload your CV",
    hint: "The agent uses it to tailor cover letters and match roles.",
    to: "/settings",
    icon: FileText,
  },
  "job-sources": {
    label: "Add a job source",
    hint: "Configure at least one site the agent is allowed to browse.",
    to: "/jobs",
    icon: Globe,
  },
  browser: {
    label: "Connect your browser",
    hint: "Pair the Chrome extension so the agent can reach login-walled listings.",
    to: "/settings",
    icon: Chrome,
  },
}

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
  const { data: preflight } = usePreflight()
  const startRun = useStartRun()
  const stopRun = useStopRun()

  // The checklist modal's contents — either populated from a proactive
  // usePreflight() read (banner "Review setup" click) or from the 428 the
  // server returns if /api/start is attempted anyway (belt-and-suspenders:
  // the client-side preflight cache could be briefly stale).
  const [checklistMissing, setChecklistMissing] = useState<string[] | null>(
    null,
  )

  const isRunning = status?.status === "running"
  const stats = pipeline?.stats ?? {
    total: 0,
    byStatus: {} as Partial<Record<string, number>>,
    dueFollowUps: 0,
  }
  const listings = pipeline?.listings ?? []

  const doStart = () =>
    startRun.mutate(undefined, {
      onSuccess: () => {
        setChecklistMissing(null)
        toast.success("Agent run initiated")
      },
      onError: (e: unknown) =>
        toast.error("Couldn't start the agent", {
          description: (e as { message?: string })?.message,
        }),
    })

  const handleStart = () => {
    // Advisory pre-flight from the cached usePreflight() read.
    //
    // DESIGN (per user request, 2026-07-21):
    //   • `job-sources` missing → BLOCKING modal. A run with zero configured
    //     sources can't discover anything, so the button would silently do
    //     nothing. The modal offers deep-links + "Start anyway".
    //   • `cv` / `browser` missing → non-blocking toast warning, then start.
    //     The run is still useful (the agent can browse job-sources without
    //     login, draft letters once a CV is added later, etc.) so blocking
    //     would be heavy-handed.
    //
    // If preflight itself errored or hasn't loaded, just start — the server
    // no longer gates either, so the worst case is a wasted run, not a
    // broken UI.
    if (preflight && preflight.missing.includes("job-sources")) {
      setChecklistMissing(preflight.missing)
      return
    }
    if (preflight) {
      const other = preflight.missing.filter(k => k !== "job-sources")
      if (other.length > 0) {
        const noun =
          other.includes("cv") && other.includes("browser")
            ? "No CV or browser connected — the agent will be limited."
            : other.includes("cv")
              ? "No CV uploaded — cover letters won't work yet."
              : "No browser connected — login-walled sites will be skipped."
        toast.warning("Starting anyway", { description: noun })
      }
    }
    doStart()
  }
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
                {/* Previously this panel showed hardcoded "Target Boards: HN,
                  LinkedIn" + "Auto Cover Letters: Enabled" strings that bore
                  no relationship to real state. Replaced with the actual
                  preflight checklist so the dashboard is truthful about
                  capability — matches the Phase 1 target-UX principle
                  ("Dashboard is always truthful about capability"). */}
                {(["cv", "job-sources", "browser"] as const).map(key => {
                  const ok = !preflight?.missing.includes(key)
                  const item = PREFLIGHT_ITEMS[key]
                  const Icon = item.icon
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon className="size-3.5" />
                        {item.label}
                      </span>
                      <span
                        className={`font-medium ${
                          ok ? "text-success" : "text-warning"
                        }`}
                      >
                        {ok ? "Ready" : "Needed"}
                      </span>
                    </div>
                  )
                })}
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
                  {/* Plain <a href> forces a full page reload — replaced with
                    a router <Link> so the SPA state + QueryClient cache
                    survive the navigation. Part of the Phase 4 parity list
                    but trivial enough to fix in passing here. */}
                  <Link to="/jobs">
                    Review on Board <ArrowUpRight className="size-3 ml-1" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Pre-flight checklist modal — opens ONLY when the cached usePreflight()
          read says job-sources is missing (the one case where a run literally
          cannot discover anything). CV and browser warnings go through
          handleStart() as toasts instead. "Start anyway" lets the user force
          a no-op run if they want (e.g. they'll add sources manually
          mid-run). Deep-link buttons open Settings or Jobs in a new tab. */}
      <PreflightDialog
        missing={checklistMissing}
        onClose={() => setChecklistMissing(null)}
        onStartAnyway={() => {
          setChecklistMissing(null)
          doStart()
        }}
        startingAnyway={startRun.isPending}
      />
    </div>
  )
}

function PreflightDialog({
  missing,
  onClose,
  onStartAnyway,
  startingAnyway,
}: {
  missing: string[] | null
  onClose: () => void
  onStartAnyway: () => void
  startingAnyway: boolean
}) {
  const open = missing !== null && missing.length > 0
  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a job source first</DialogTitle>
          <DialogDescription>
            The agent needs at least one configured job website to search. You
            can still start a run without sources, but it won&apos;t be able to
            discover anything — pair now, or start anyway.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3 py-2">
          {(missing ?? []).map(key => {
            const item = PREFLIGHT_ITEMS[key] ?? {
              label: key,
              hint: "(no description)",
              to: "/settings",
              icon: CircleAlert,
            }
            const Icon = item.icon
            return (
              <li key={key} className="flex items-start gap-3">
                <span className="size-8 rounded-md bg-warning/10 border border-warning/30 grid place-items-center text-warning shrink-0">
                  <Icon className="size-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {item.hint}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link to={item.to}>Fix</Link>
                </Button>
              </li>
            )
          })}
        </ul>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onStartAnyway} disabled={startingAnyway}>
            {startingAnyway ? "Starting…" : "Start anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

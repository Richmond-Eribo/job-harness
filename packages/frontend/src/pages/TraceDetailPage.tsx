import { useParams, Link } from "@tanstack/react-router"
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Cpu,
  Terminal,
  CircleAlert,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useRunTrace } from "../hooks/queries"
import type { TraceEvent } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@agent-harness/ui"

const EVENT_FILTERS = [
  "all",
  "reasoning",
  "tool_call",
  "tool_result",
  "error",
] as const

const EVENT_BADGE: Record<string, string> = {
  reasoning: "bg-violet-400/10 text-violet-400 border-violet-400/20",
  text: "bg-foreground/5 text-foreground border-border",
  tool_call: "bg-warning/10 text-warning border-warning/20",
  tool_result: "bg-success/10 text-success border-success/20",
  step_end: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/10 text-destructive border-destructive/20",
  system: "bg-muted text-muted-foreground border-border",
}

export function TraceDetailPage() {
  const { runId } = useParams({ from: "/_app/traces/$runId" })
  const { data, isLoading, isError, error, refetch } = useRunTrace(runId)
  const [eventFilter, setEventFilter] = useState<string>("all")

  const events = data?.events ?? data?.trace ?? []
  const run = data?.run

  // Group events by stepNumber, filtered. Memoized — recomputed only when
  // events reference or eventFilter change, not on every render.
  const steps = useMemo(() => {
    const m = new Map<string, TraceEvent[]>()
    for (const ev of events) {
      if (eventFilter !== "all" && ev.eventType !== eventFilter) continue
      const key = String(ev.stepNumber ?? "_pre")
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(ev)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, eventFilter])

  const stepCount = steps.size

  // Single stable handler for all filter tabs, keyed on the tab string.
  const onSelectFilter = useCallback((tab: string) => setEventFilter(tab), [])

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 animate-fade-in">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <Link
          to="/traces"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors font-medium"
        >
          <ArrowLeft className="size-3.5" />
          Back to all traces
        </Link>
        <span className="font-mono text-xs text-muted-foreground">
          Trace ID: {runId}
        </span>
      </div>

      {/* Main Split Inspector View */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Run Metadata Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                Run Metadata Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="flex items-center justify-between p-2.5 bg-secondary/40 rounded-lg border border-border">
                <span className="text-muted-foreground">Execution Status</span>
                <Badge
                  variant={
                    run?.status === "running"
                      ? "default"
                      : run?.status === "error"
                        ? "destructive"
                        : "secondary"
                  }
                  className="capitalize"
                >
                  {run?.status ?? "Completed"}
                </Badge>
              </div>

              <div className="space-y-2.5">
                <div>
                  <span className="text-muted-foreground block mb-1">
                    Goal Statement
                  </span>
                  <p className="font-medium text-foreground bg-background p-2.5 rounded-lg border border-border leading-relaxed">
                    {run?.goal || "Automated search and profile evaluation run"}
                  </p>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-muted-foreground">
                    Total Steps Recorded
                  </span>
                  <span className="font-mono font-semibold text-foreground">
                    {stepCount}
                  </span>
                </div>

                {run?.startedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Started Time</span>
                    <span className="font-mono text-foreground">
                      {new Date(run.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-muted-foreground">Agent Engine</span>
                  <span className="inline-flex items-center gap-1 font-mono text-primary">
                    <Cpu className="size-3" /> Harness Agent
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Interactive Transcript Inspector */}
        <div className="lg:col-span-2 space-y-4">
          {/* Filter Bar */}
          <div className="flex items-center justify-between bg-card p-2 rounded-xl border border-border">
            <div className="flex items-center gap-1">
              {EVENT_FILTERS.map(tab => (
                <button
                  key={tab}
                  onClick={() => onSelectFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                    eventFilter === tab
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                  }`}
                >
                  {tab.replace("_", " ")}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground font-mono px-2">
              {events.length} events
            </span>
          </div>

          {/* Transcript Timeline Steps */}
          {isError ? (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="py-8 text-center">
                <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
                <p className="text-sm font-medium">Failed to load trace</p>
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
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-36 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="relative flex flex-col gap-4">
              {/* Vertical Timeline Bar */}
              <div
                className="absolute left-[18px] top-6 bottom-6 w-px bg-border"
                aria-hidden
              />

              {Array.from(steps.entries()).map(([stepNum, evs], i) => (
                <StepCard
                  key={stepNum}
                  stepNum={stepNum}
                  events={evs}
                  index={i}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StepCard({
  stepNum,
  events,
  index,
}: {
  stepNum: string
  events: TraceEvent[]
  index: number
}) {
  const agent = events[0]?.agent ?? "harness"
  return (
    <div
      className="relative pl-10 animate-slide-up stagger-child"
      style={{ "--stagger-i": index } as React.CSSProperties}
    >
      {/* Timeline Dot */}
      <div className="absolute left-3 top-4 size-3 rounded-full bg-primary/20 border-2 border-primary z-10" />

      <Card className="overflow-hidden py-0 gap-0">
        <CardHeader className="px-4 py-3 flex-row items-center justify-between border-b border-border bg-secondary/30">
          <span className="text-xs font-mono font-bold text-foreground">
            {stepNum === "_pre" ? "INITIALIZATION" : `STEP ${stepNum}`}
          </span>
          <span className="text-xs text-primary font-mono bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
            {agent}
          </span>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          {events.map((ev, i) => (
            <EventRow key={`${ev.eventType}-${i}`} ev={ev} />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function EventRow({ ev }: { ev: TraceEvent }) {
  const label = ev.eventType?.toUpperCase()
  const badgeClass =
    EVENT_BADGE[ev.eventType] ?? "bg-muted text-muted-foreground border-border"
  const [expanded, setExpanded] = useState(false)

  const payload = ev.payload
  const isLong = typeof payload === "string" && payload.length > 500

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${badgeClass}`}
        >
          {label}
        </span>
        {ev.label && (
          <span className="text-xs text-muted-foreground font-mono">
            {ev.label}
          </span>
        )}
      </div>
      {payload && (
        <div className="relative">
          <pre className="text-xs text-muted-foreground bg-background border border-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words font-mono max-h-60 leading-relaxed">
            {isLong && !expanded ? payload.slice(0, 500) + "…" : payload}
          </pre>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline mt-1 font-mono"
            >
              {expanded ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
              {expanded
                ? "Collapse payload"
                : `Expand full payload (${payload.length} characters)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

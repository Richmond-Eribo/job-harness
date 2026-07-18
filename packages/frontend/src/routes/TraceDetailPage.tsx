import { useParams, Link } from "@tanstack/react-router"
import { useRunTrace } from "../hooks/queries"
import { Badge, Card, CardContent, Skeleton } from "@agent-harness/ui"

// The transcript view — renders the step-grouped trace events.
export function TraceDetailPage() {
  const { runId } = useParams({ from: "/traces/$runId" })
  const { data, isLoading } = useRunTrace(runId)

  const events = data?.events ?? data?.trace ?? []
  const run = data?.run

  // Group events by stepNumber for display.
  const steps = new Map<string, any[]>()
  for (const ev of events) {
    const key = String(ev.stepNumber ?? "_pre")
    if (!steps.has(key)) steps.set(key, [])
    steps.get(key)!.push(ev)
  }

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/traces" className="text-sm text-primary hover:underline mb-4 inline-block">
        ← All traces
      </Link>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-mono">{runId}</h1>
        {run?.status && (
          <Badge variant="secondary" className="capitalize">{run.status}</Badge>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from(steps.entries()).map(([stepNum, evs]) => (
            <StepCard key={stepNum} stepNum={stepNum} events={evs} />
          ))}
        </div>
      )}
    </div>
  )
}

function StepCard({ stepNum, events }: { stepNum: string; events: any[] }) {
  const agent = events[0]?.agent ?? "harness"
  return (
    <Card className="overflow-hidden py-0">
      <div className="px-4 py-2.5 flex items-center gap-3 border-b border-border bg-secondary/40">
        <span className="text-xs font-mono font-bold text-foreground">
          {stepNum === "_pre" ? "RUN" : `STEP ${stepNum}`}
        </span>
        <span className="text-xs text-primary">{agent}</span>
      </div>
      <CardContent className="p-4 flex flex-col gap-3">
        {events.map((ev, i) => (
          <EventRow key={i} ev={ev} />
        ))}
      </CardContent>
    </Card>
  )
}

function EventRow({ ev }: { ev: any }) {
  const label = ev.eventType?.toUpperCase()
  // Role-based accents via semantic tokens (no raw colors except where a
  // distinct hue aids scanning — tool/result/errors keep amber/emerald/red).
  const colors: Record<string, string> = {
    reasoning: "text-purple-400",
    text: "text-foreground",
    tool_call: "text-amber-400",
    tool_result: "text-emerald-400",
    step_end: "text-muted-foreground",
    error: "text-destructive",
    system: "text-muted-foreground",
  }
  return (
    <div>
      <div className={`text-xs font-mono mb-1 ${colors[ev.eventType] ?? "text-muted-foreground"}`}>
        {label} {ev.label ? `· ${ev.label}` : ""}
      </div>
      {ev.payload && (
        <pre className="text-xs text-muted-foreground bg-background border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-60">
          {typeof ev.payload === "string" && ev.payload.length > 1000
            ? ev.payload.slice(0, 1000) + "…"
            : ev.payload}
        </pre>
      )}
    </div>
  )
}

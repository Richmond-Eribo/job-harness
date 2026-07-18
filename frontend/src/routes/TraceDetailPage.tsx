import { useParams, Link } from "@tanstack/react-router"
import { useRunTrace } from "../hooks/queries"

// The transcript view — renders the step-grouped trace events. This is a
// functional port of the legacy renderTranscript; the full nested-block
// rendering (reasoning → text → tools → sub-agent) can be refined later.
export function TraceDetailPage() {
  const { runId } = useParams({ from: "/traces/$runId" })
  const { data, isLoading } = useRunTrace(runId)

  const events = data?.events ?? data?.trace ?? []
  const run = data?.run ?? {}

  // Group events by stepNumber for display.
  const steps = new Map<string, any[]>()
  for (const ev of events) {
    const key = String(ev.stepNumber ?? "_pre")
    if (!steps.has(key)) steps.set(key, [])
    steps.get(key)!.push(ev)
  }

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/traces" className="text-sm text-accent hover:underline mb-4 inline-block">
        ← All traces
      </Link>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-mono">{runId}</h1>
        {run.status && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-ink-800 text-ink-400">
            {run.status}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : (
        <div className="space-y-3">
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
    <div className="bg-ink-900 rounded-xl border border-ink-800 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-3 border-b border-ink-800 bg-ink-950/50">
        <span className="text-xs font-mono font-bold text-ink-300">
          {stepNum === "_pre" ? "RUN" : `STEP ${stepNum}`}
        </span>
        <span className="text-xs text-accent">{agent}</span>
      </div>
      <div className="p-4 space-y-3">
        {events.map((ev, i) => (
          <EventRow key={i} ev={ev} />
        ))}
      </div>
    </div>
  )
}

function EventRow({ ev }: { ev: any }) {
  const label = ev.eventType?.toUpperCase()
  const colors: Record<string, string> = {
    reasoning: "text-purple-400",
    text: "text-ink-100",
    tool_call: "text-amber-400",
    tool_result: "text-emerald-400",
    step_end: "text-ink-500",
    error: "text-red-400",
    system: "text-ink-500",
  }
  return (
    <div>
      <div className={`text-xs font-mono mb-1 ${colors[ev.eventType] ?? "text-ink-400"}`}>
        {label} {ev.label ? `· ${ev.label}` : ""}
      </div>
      {ev.payload && (
        <pre className="text-xs text-ink-400 bg-ink-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-60">
          {typeof ev.payload === "string" && ev.payload.length > 1000
            ? ev.payload.slice(0, 1000) + "…"
            : ev.payload}
        </pre>
      )}
    </div>
  )
}

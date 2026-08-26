import { useParams, Link } from "@tanstack/react-router"
import {
  ArrowLeft,
  Brain,
  Braces,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Cpu,
  Layers,
  MessageSquare,
  Terminal,
  Wrench,
} from "lucide-react"
import { useMemo, useState, type CSSProperties } from "react"
import { useRunTrace } from "../hooks/queries"
import { useTabParam } from "../hooks/use-tab-param"
import type { TraceEvent } from "@/types"
import { Markdown } from "../components/markdown"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@agent-harness/ui"

// =============================================================================
// TraceDetailPage — a seq-ordered agent transcript, not an event dump.
// =============================================================================
// ORDERING MODEL (matches the backend's capture semantics):
//   · `seq` is the source of truth — events are sorted by it explicitly.
//   · Top level = HARNESS events only (parentId == null), grouped into STEP
//     cards by stepNumber (null → INITIALIZATION). Sub-agent events carry
//     their own inner-loop step numbers and NEVER group at top level — they
//     nest under the harness tool_call that delegated (via parentId → the
//     parent's toolCallId). This is what previously rendered a cover-letter
//     system prompt (with the whole CV) as a "second soul document" in STEP 0.
//   · Within a step, narrative order (think → say → act → observe) — NOT seq
//     order: the backend flushes reasoning/text buffers at step end, so raw
//     seq order would show the thinking AFTER the tools it triggered.
//   · "raw" view mode preserves the old per-event debug rendering.
// =============================================================================

const EVENT_FILTERS = [
  "all",
  "reasoning",
  "text",
  "tool_call",
  "tool_result",
  "compaction",
  "error",
] as const

const VIEW_MODES = ["narrative", "raw"] as const

const AGENT_BADGE: Record<string, string> = {
  harness: "bg-primary/10 text-primary border-primary/20",
  "job-agent": "bg-warning/10 text-warning border-warning/20",
  "browser-agent": "bg-success/10 text-success border-success/20",
}

// ── small helpers ───────────────────────────────────────────────────────────

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—"
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** Wall-clock duration for a whole run — minutes+seconds, not fractions. */
function fmtRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

function parseJsonSafe<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function prettyPayload(p: string | null | undefined): string {
  if (!p) return ""
  const parsed = parseJsonSafe(p)
  if (parsed != null && typeof parsed === "object") {
    try {
      return JSON.stringify(parsed, null, 2)
    } catch {
      return p
    }
  }
  return p
}

// ── item model: one narrative row in a step (or a nested sub-agent block) ──

type Item =
  | { kind: "thinking"; ev: TraceEvent }
  | { kind: "message"; ev: TraceEvent }
  | {
      kind: "tool"
      call: TraceEvent
      result: TraceEvent | undefined
      children: TraceEvent[]
    }
  | { kind: "collapsed"; ev: TraceEvent }
  | { kind: "error"; ev: TraceEvent }

/** Events that render as collapsed raw rows in narrative mode. */
const COLLAPSED_TYPES = new Set([
  "system",
  "prompt",
  "run_start",
  "run_end",
  "subagent_start",
  "compaction",
  "step_end",
])

/**
 * Build narrative-ordered items from one event list. `nestedByParent` maps
 * parentId → the sub-agent events to nest inside that parent tool card.
 */
function buildItems(
  events: TraceEvent[],
  nestedByParent: Map<string, TraceEvent[]>,
): Item[] {
  const thinking: Item[] = []
  const messages: Item[] = []
  const tools: Item[] = []
  const collapsed: Item[] = []
  const errors: Item[] = []
  for (const ev of events) {
    switch (ev.eventType) {
      case "reasoning":
        thinking.push({ kind: "thinking", ev })
        break
      case "text":
        messages.push({ kind: "message", ev })
        break
      case "tool_call":
        tools.push({
          kind: "tool",
          call: ev,
          result: events.find(
            e =>
              e.eventType === "tool_result" &&
              e.toolCallId != null &&
              e.toolCallId === ev.toolCallId,
          ),
          children: ev.toolCallId
            ? (nestedByParent.get(ev.toolCallId) ?? [])
            : [],
        })
        break
      case "error":
        errors.push({ kind: "error", ev })
        break
      default:
        if (COLLAPSED_TYPES.has(ev.eventType)) {
          collapsed.push({ kind: "collapsed", ev })
        }
        break
    }
  }
  return [...thinking, ...messages, ...tools, ...collapsed, ...errors]
}

/** Stable seq for React keys — the tool variant keys off its tool_call event. */
function itemSeq(item: Item): number {
  return item.kind === "tool" ? item.call.seq : item.ev.seq
}

/** Does this item match the active event-type filter? */
function itemMatches(item: Item, filter: string): boolean {  if (filter === "all") return true
  switch (item.kind) {
    case "thinking":
      return filter === "reasoning"
    case "message":
      return filter === "text"
    case "tool":
      return filter === "tool_call" || filter === "tool_result"
    case "error":
      return filter === "error"
    case "collapsed":
      return item.ev.eventType === filter
  }
}

// ── page ────────────────────────────────────────────────────────────────────

export function TraceDetailPage() {
  const { runId } = useParams({ from: "/_app/traces/$runId" })
  const { data, isLoading, isError, error, refetch } = useRunTrace(runId)
  // URL state (?filter=…&view=…) so a filtered transcript view is shareable
  // and survives refresh (useTabParam — same mechanism as the Settings tabs).
  const [eventFilter, setEventFilter] = useTabParam(
    "filter",
    EVENT_FILTERS,
    "all",
  )
  const [viewMode, setViewMode] = useTabParam(
    "view",
    VIEW_MODES,
    "narrative",
  )

  const events = data?.events ?? data?.trace ?? []
  const run = data?.run

  // Explicit seq sort + top-level/nested split, memoized.
  const { steps, nestedByParent } = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    const nested = new Map<string, TraceEvent[]>()
    const top: TraceEvent[] = []
    for (const ev of sorted) {
      if (ev.parentId) {
        const list = nested.get(ev.parentId) ?? []
        list.push(ev)
        nested.set(ev.parentId, list)
      } else {
        top.push(ev)
      }
    }
    const m = new Map<string, TraceEvent[]>()
    for (const ev of top) {
      const key = String(ev.stepNumber ?? "_pre")
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(ev)
    }
    return { steps: m, nestedByParent: nested }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events])

  // Prefer the corrected harness-only rollup (max harness step_end); fall
  // back to the grouped cards minus the INITIALIZATION bucket, which is not
  // a step — the raw group count was off by one (34 shown for a 33-step run).
  const stepCount =
    run?.steps ?? Math.max(0, steps.size - (steps.has("_pre") ? 1 : 0))

  const onSelectFilter = (tab: (typeof EVENT_FILTERS)[number]) =>
    setEventFilter(tab)

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
              <div className="flex items-center justify-between p-2.5 bg-muted/50 rounded-lg border border-border">
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
                  {run?.status ?? (run?.endedAt ? "completed" : "running")}
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

                {(run?.tokensIn != null || run?.tokensOut != null) && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Tokens</span>
                    <span
                      className="font-mono text-foreground"
                      title="input / output (all agents)"
                    >
                      {fmtTokens(run?.tokensIn)} in ·{" "}
                      {fmtTokens(run?.tokensOut)} out
                    </span>
                  </div>
                )}

                {(run?.subAgentTokensIn ?? 0) > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      Sub-agent tokens
                    </span>
                    <span
                      className="font-mono text-muted-foreground"
                      title="job-agent + browser-agent inner loops"
                    >
                      {fmtTokens(run?.subAgentTokensIn)} in ·{" "}
                      {fmtTokens(run?.subAgentTokensOut)} out
                    </span>
                  </div>
                )}

                {run?.startedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Started Time</span>
                    <span className="font-mono text-foreground">
                      {new Date(run.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}

                {run?.endedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Ended</span>
                    <span className="font-mono text-foreground">
                      {new Date(run.endedAt).toLocaleTimeString()}
                      {run?.startedAt
                        ? ` · ${fmtRunDuration(
                            new Date(run.endedAt).getTime() -
                              new Date(run.startedAt).getTime(),
                          )}`
                        : ""}
                    </span>
                  </div>
                )}

                {run?.finishReason && (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-muted-foreground">
                      Last finish reason
                    </span>
                    <span className="font-mono text-foreground">
                      {run.finishReason}
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
          {/* Filter Bar + View Toggle */}
          <div className="flex items-center justify-between bg-card p-2 rounded-xl border border-border">
            <div className="flex items-center gap-1 overflow-x-auto">
              {EVENT_FILTERS.map(tab => (
                <button
                  key={tab}
                  onClick={() => onSelectFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize whitespace-nowrap transition-colors ${
                    eventFilter === tab
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {tab.replace("_", " ")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pl-2">
              <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
                {events.length} events
              </span>
              <div className="flex items-center rounded-lg border border-border overflow-hidden">
                {VIEW_MODES.map(mode => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                      viewMode === mode
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
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
                  nestedByParent={nestedByParent}
                  filter={eventFilter}
                  mode={viewMode}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── step card ───────────────────────────────────────────────────────────────

function StepCard({
  stepNum,
  events,
  index,
  nestedByParent,
  filter,
  mode,
}: {
  stepNum: string
  events: TraceEvent[]
  index: number
  nestedByParent: Map<string, TraceEvent[]>
  filter: string
  mode: (typeof VIEW_MODES)[number]
}) {
  const items = useMemo(
    () => buildItems(events, nestedByParent),
    [events, nestedByParent],
  )
  // Raw (debug) mode interleaves the nested sub-agent events back in, in seq
  // order — the narrative view deliberately hoists them under tool cards, but
  // the debug view must show exactly what the event log holds.
  const rawEvents = useMemo(() => {
    const withChildren: TraceEvent[] = []
    for (const ev of events) {
      withChildren.push(ev)
      if (ev.eventType === "tool_call" && ev.toolCallId) {
        withChildren.push(...(nestedByParent.get(ev.toolCallId) ?? []))
      }
    }
    return withChildren.sort((a, b) => a.seq - b.seq)
  }, [events, nestedByParent])
  const visible = items.filter(it => itemMatches(it, filter))
  if (visible.length === 0 && filter !== "all") return null

  // Usage chip data comes from the step's (harness) step_end event.
  const stepEnd = events.find(e => e.eventType === "step_end")

  return (
    <div
      className="relative pl-10 animate-slide-up stagger-child"
      style={{ "--stagger-i": index } as CSSProperties}
    >
      {/* Timeline Dot */}
      <div className="absolute left-3 top-4 size-3 rounded-full bg-primary/20 border-2 border-primary z-10" />

      <Card className="overflow-hidden py-0 gap-0">
        <CardHeader className="px-4 py-3 flex-row items-center justify-between border-b border-border bg-muted/40 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono font-bold text-foreground whitespace-nowrap">
              {stepNum === "_pre" ? "INITIALIZATION" : `STEP ${stepNum}`}
            </span>
            {stepEnd && (
              <span className="text-[10px] font-mono text-muted-foreground truncate">
                {fmtTokens(stepEnd.tokensIn)} in ·{" "}
                {fmtTokens(stepEnd.tokensOut)} out
                {stepEnd.tokensReasoning
                  ? ` · ${fmtTokens(stepEnd.tokensReasoning)} think`
                  : ""}
                {stepEnd.cacheRead
                  ? ` · ${fmtTokens(stepEnd.cacheRead)} cached`
                  : ""}
                {" · "}
                {fmtDuration(stepEnd.durationMs)}
                {stepEnd.model ? ` · ${stepEnd.model}` : ""}
              </span>
            )}
          </div>
          {stepEnd?.label && (
            <Badge variant="secondary" className="text-[10px] font-mono shrink-0">
              {stepEnd.label}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          {mode === "raw"
            ? rawEvents
                .filter(ev => filter === "all" || ev.eventType === filter)
                .map((ev, i) => <RawEventRow key={`${ev.seq}-${i}`} ev={ev} />)
            : visible.map((item, i) => (
                <NarrativeItem
                  key={`${item.kind}-${itemSeq(item)}-${i}`}
                  item={item}
                  nestedByParent={nestedByParent}
                />
              ))}
          {mode === "narrative" && visible.length === 0 && (
            <p className="text-xs text-muted-foreground font-mono">
              (no events)
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── narrative rendering ─────────────────────────────────────────────────────

function NarrativeItem({
  item,
  nestedByParent,
}: {
  item: Item
  nestedByParent: Map<string, TraceEvent[]>
}) {
  switch (item.kind) {
    case "thinking":
      return <ThinkingBlock text={item.ev.payload ?? ""} />
    case "message":
      return (
        <div className="rounded-xl border border-border bg-background px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
            <MessageSquare className="size-3.5" />
            Message
          </div>
          <Markdown>{item.ev.payload ?? ""}</Markdown>
        </div>
      )
    case "tool":
      return <ToolCard item={item} nestedByParent={nestedByParent} />
    case "error":
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <CircleAlert className="size-3.5" />
            {item.ev.label ?? "Error"}
          </div>
          <pre className="text-xs text-destructive/90 font-mono whitespace-pre-wrap break-words">
            {item.ev.payload}
          </pre>
        </div>
      )
    case "collapsed":
      return <CollapsedRow ev={item.ev} />
  }
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-xl border border-violet-400/25 bg-violet-400/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-violet-400 hover:bg-violet-400/10 transition-colors"
      >
        <Brain className="size-3.5" />
        Thinking
        {expanded ? (
          <ChevronUp className="size-3.5 ml-auto" />
        ) : (
          <ChevronDown className="size-3.5 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3 -mt-1 max-h-96 overflow-y-auto">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}

function ToolCard({
  item,
  nestedByParent,
}: {
  item: Extract<Item, { kind: "tool" }>
  nestedByParent: Map<string, TraceEvent[]>
}) {
  const { call, result, children } = item
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <Wrench className="size-3.5 text-warning shrink-0" />
        <span className="text-xs font-mono font-semibold text-foreground">
          {call.label ?? "tool"}
        </span>
        {result?.durationMs != null && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {fmtDuration(result.durationMs)}
          </span>
        )}
        {!result && (
          <span className="text-[10px] font-mono text-muted-foreground/60">
            no result captured
          </span>
        )}
        {open ? (
          <ChevronUp className="size-3.5 ml-auto text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 ml-auto text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          <PayloadBlock label="Arguments" payload={call.payload} />
          {result && <PayloadBlock label="Result" payload={result.payload} />}
          {children.length > 0 && (
            <SubAgentTimeline
              events={children}
              nestedByParent={nestedByParent}
            />
          )}
        </div>
      )}
      {/* Nested sub-agent activity is visible even when the tool card is
          collapsed — it's the interesting part of delegating tools. */}
      {!open && children.length > 0 && (
        <div className="px-4 pb-3">
          <SubAgentTimeline
            events={children}
            nestedByParent={nestedByParent}
          />
        </div>
      )}
    </div>
  )
}

function PayloadBlock({
  label,
  payload,
}: {
  label: string
  payload: string | null | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const text = payload ?? ""
  const pretty = prettyPayload(text)
  const isLong = pretty.length > 400
  const shown = isLong && !expanded ? pretty.slice(0, 400) + "…" : pretty
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
        <Braces className="size-3" />
        {label}
        {text.length > 0 && (
          <span className="font-mono normal-case">
            {isLong && !expanded ? ` (${text.length} chars)` : ""}
          </span>
        )}
      </div>
      <pre className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-words font-mono max-h-72 overflow-y-auto leading-relaxed">
        {shown}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[11px] text-primary hover:underline font-mono"
        >
          {expanded ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          {expanded ? "Collapse" : "Expand full payload"}
        </button>
      )}
    </div>
  )
}

/**
 * A sub-agent's nested event timeline — everything with the same parentId,
 * rendered compactly and indented under the delegating tool card. Reuses the
 * narrative item builder so inner reasoning/tools render the same way.
 */
function SubAgentTimeline({
  events,
  nestedByParent,
}: {
  events: TraceEvent[]
  nestedByParent: Map<string, TraceEvent[]>
}) {
  const items = useMemo(
    () => buildItems(events, nestedByParent),
    [events, nestedByParent],
  )
  const agent = events[0]?.agent ?? "job-agent"
  const start = events.find(e => e.eventType === "subagent_start")
  const startInfo = parseJsonSafe<{ goal?: string }>(start?.payload)
  const usage = events.filter(e => e.eventType === "step_end")
  const tokensIn = usage.reduce((s, e) => s + (e.tokensIn ?? 0), 0)
  const tokensOut = usage.reduce((s, e) => s + (e.tokensOut ?? 0), 0)

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="size-3.5 text-muted-foreground" />
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${
            AGENT_BADGE[agent] ?? "bg-muted text-muted-foreground border-border"
          }`}
        >
          {agent}
        </span>
        {startInfo?.goal && (
          <span className="text-[11px] text-muted-foreground font-mono truncate max-w-[30rem]">
            {startInfo.goal}
          </span>
        )}
        <span className="text-[10px] font-mono text-muted-foreground ml-auto whitespace-nowrap">
          {fmtTokens(tokensIn)} in · {fmtTokens(tokensOut)} out
        </span>
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <SubAgentItem
            key={`${item.kind}-${itemSeq(item)}-${i}`}
            item={item}
            nestedByParent={nestedByParent}
          />
        ))}
      </div>
    </div>
  )
}

function SubAgentItem({
  item,
  nestedByParent,
}: {
  item: Item
  nestedByParent: Map<string, TraceEvent[]>
}) {
  switch (item.kind) {
    case "thinking":
      return <ThinkingBlock text={item.ev.payload ?? ""} />
    case "message":
      return (
        <div className="px-1">
          <Markdown>{item.ev.payload ?? ""}</Markdown>
        </div>
      )
    case "tool":
      return (
        <ToolCard item={item} nestedByParent={nestedByParent} />
      )
    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <span className="text-xs font-mono text-destructive">
            {item.ev.payload}
          </span>
        </div>
      )
    case "collapsed":
      return <CollapsedRow ev={item.ev} />
  }
}

// ── collapsed raw rows (init events, prompts, run markers, compaction) ─────

function collapsedSummary(ev: TraceEvent): string {
  const p = parseJsonSafe<Record<string, unknown>>(ev.payload)
  switch (ev.eventType) {
    case "run_start":
      return p?.goal ? `goal: ${String(p.goal)}` : "run began"
    case "system":
      if (ev.label === "plan") {
        const steps = Array.isArray(p?.steps) ? p.steps.length : null
        return steps != null
          ? `structured plan — ${steps} steps`
          : "structured plan"
      }
      if (ev.label === "job-applied") {
        return `job ${p?.jobId ?? "?"} moved to applied (assisted apply run)`
      }
      return `system prompt — ${(ev.payload ?? "").length.toLocaleString()} chars`
    case "prompt":
      return `messages sent this turn — ${(ev.payload ?? "").length.toLocaleString()} chars`
    case "run_end":
      return `run ended (${ev.label ?? "unknown"}) — ${(
        ev.payload ?? ""
      ).slice(0, 140)}`
    case "subagent_start":
      return p?.goal ? String(p.goal) : "sub-agent loop started"
    case "compaction": {
      const before = typeof p?.beforeTokens === "number" ? p.beforeTokens : null
      return before != null
        ? `context compacted — prompt was ${fmtTokens(before)} tokens; older turns summarized`
        : "context compacted — older turns summarized"
    }
    case "step_end":
      return `turn finished — ${ev.label ?? ""}`
    default:
      return (ev.payload ?? "").slice(0, 140)
  }
}

function CollapsedRow({ ev }: { ev: TraceEvent }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-accent/40 transition-colors"
      >
        <Badge variant="secondary" className="text-[10px] font-mono shrink-0">
          {ev.label ?? ev.eventType}
        </Badge>
        <span className="text-[11px] text-muted-foreground font-mono truncate">
          {collapsedSummary(ev)}
        </span>
        {expanded ? (
          <ChevronUp className="size-3 ml-auto text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3 ml-auto text-muted-foreground shrink-0" />
        )}
      </button>
      {expanded && (
        <pre className="mx-3 mb-3 text-xs text-muted-foreground bg-background border border-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words font-mono max-h-80 overflow-y-auto leading-relaxed">
          {prettyPayload(ev.payload)}
        </pre>
      )}
    </div>
  )
}

// ── raw (debug) rendering — the original per-event view ─────────────────────

const EVENT_BADGE: Record<string, string> = {
  reasoning: "bg-violet-400/10 text-violet-400 border-violet-400/20",
  text: "bg-foreground/5 text-foreground border-border",
  tool_call: "bg-warning/10 text-warning border-warning/20",
  tool_result: "bg-success/10 text-success border-success/20",
  step_end: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/10 text-destructive border-destructive/20",
  system: "bg-muted text-muted-foreground border-border",
  subagent_start: "bg-success/10 text-success border-success/20",
  compaction: "bg-primary/10 text-primary border-primary/20",
  run_start: "bg-muted text-muted-foreground border-border",
  run_end: "bg-muted text-muted-foreground border-border",
}

function RawEventRow({ ev }: { ev: TraceEvent }) {
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
        <span className="text-[10px] font-mono text-muted-foreground/70 ml-auto">
          seq {ev.seq}
          {ev.parentId ? ` · nested` : ""}
        </span>
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

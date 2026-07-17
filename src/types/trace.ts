// =============================================================================
// Trace event types — the append-only event log that powers traces + logs.
// =============================================================================
// A trace is a hierarchical, append-only record of one model turn. Each event
// is a row in trace_events. This mirrors the OpenTelemetry GenAI Semantic
// Conventions shape (invoke_agent → chat → execute_tool) but flattened into
// one table with monotonic seq ordering.
//
// event_type taxonomy:
//   run_start      — run began (carries goal + composed system prompt ref)
//   system         — the FULL composed system prompt for this run (soul.md +
//                    default.md + user_memory + live context)
//   prompt         — messages array actually sent to the model for this turn
//   reasoning      — model chain-of-thought delta
//   text           — model text output delta
//   tool_call      — the model invoked a tool (carries args)
//   tool_result    — the tool returned (carries result)
//   step_end       — one LLM turn finished (usage, finishReason, model, duration)
//   run_end        — run finished (carries summary)
//   error          — run errored
//
// AGENT ATTRIBUTION (v2):
//   `agent` records WHICH agent emitted the event — "harness",
//   "job-agent", or "research-agent". Before v2 only the Harness wrote trace
//   rows, so the two capability-provider sub-agents (which run their own inner
//   LLM loops) were invisible. Now sub-agents buffer their events and return
//   them on the RPC response; the Harness ingests them with the correct agent
//   label, so the transcript shows exactly who did what.
//
// NESTING:
//   `parentId` / `parentLabel` let a sub-agent's events nest visually under the
//   delegating tool call (e.g. job-agent's search_site → fetch_page → save_job
//   appear indented under the harness's discover_jobs tool_call). parentId is
//   the toolCallId of the parent call.
// =============================================================================

/** Identifier of which agent emitted an event. Drives color + grouping in the UI. */
export type TraceAgent = "harness" | "job-agent" | "research-agent" | "browser-agent"

export type TraceEventType =
  | "run_start"
  | "system"
  | "prompt"
  | "reasoning"
  | "text"
  | "tool_call"
  | "tool_result"
  | "step_end"
  | "run_end"
  | "error"

export interface TraceEvent {
  id: number
  runId: string
  stepNumber: number | null
  seq: number
  eventType: TraceEventType
  role: string | null // system|user|assistant|tool (for prompt rows)
  label: string | null // toolName / model id / "step N"
  payload: string | null // JSON string of content (message, args, parts, usage, etc.)
  tokensIn: number | null
  tokensOut: number | null
  tokensReasoning: number | null
  durationMs: number | null
  model: string | null
  createdAt: string
  // ── v2 attribution + nesting + cache + truncation ───────────────────────
  /** Which agent emitted this. Defaults to "harness" for legacy rows. */
  agent: TraceAgent
  /** Pairs a tool_call to its tool_result (AI SDK toolCallId). */
  toolCallId: string | null
  /** Parent toolCallId — set on sub-agent events so they nest under the caller. */
  parentId: string | null
  /** Parent tool name (e.g. "discover_jobs") — display without a join. */
  parentLabel: string | null
  /** Prompt-cache read tokens (inputTokenDetails.cacheReadTokens). */
  cacheRead: number | null
  /** Prompt-cache write tokens (inputTokenDetails.cacheWriteTokens). */
  cacheWrite: number | null
  /** 1 when the payload was sliced to fit — UI shows a truncation marker. */
  truncated: number | null
}

/** New trace event to insert. `seq`, `id`, `createdAt` are DB-assigned. */
export interface TraceEventInput {
  runId: string
  stepNumber?: number | null
  eventType: TraceEventType
  role?: string | null
  label?: string | null
  payload?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  tokensReasoning?: number | null
  durationMs?: number | null
  model?: string | null
  // ── v2 attribution + nesting + cache + truncation ───────────────────────
  agent?: TraceAgent
  toolCallId?: string | null
  parentId?: string | null
  parentLabel?: string | null
  cacheRead?: number | null
  cacheWrite?: number | null
  truncated?: number | null
}

/**
 * A sub-agent's buffered events, returned inside an RPC response so the Harness
 * can ingest them into its trace_events store with the right attribution.
 * Each entry is a partial TraceEventInput (runId/parentId are filled in by the
 * harness when it ingests). `seq` is assigned at ingest time.
 */
export interface SubAgentTrace {
  agent: TraceAgent
  events: Omit<TraceEventInput, "runId" | "parentId" | "parentLabel">[]
}

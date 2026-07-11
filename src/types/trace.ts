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
// =============================================================================

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
}

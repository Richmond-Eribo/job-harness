// =============================================================================
// TraceRecorder — framework-agnostic capture of one LLM call's full trace.
// =============================================================================
// THE PROBLEM IT SOLVES
// Before v2, trace capture lived ONLY on the Harness's streamText loop, and it
// was ad-hoc: onChunk handled deltas, pushTraceEvent ran after. The two
// capability-provider sub-agents (ResearchAgent, JobApplicationAgent) run their
// OWN multi-step generateText loops but captured nothing — so when the Harness
// called `discover_jobs`, the entire job-agent inner loop (its prompt, its
// reasoning, the real search_site / fetch_page / save_job calls, its tokens)
// was invisible. The dashboard showed "discover_jobs → (result string)" with
// no idea what happened inside.
//
// This recorder is the single source of truth for "what happened during one
// LLM call", used by BOTH the Harness and the sub-agents. It:
//   1. Buffers structured TraceEventInput rows in memory.
//   2. Attaches to a generateText/streamText call via AI SDK v7 lifecycle
//      callbacks (onChunk, onStepEnd, onToolExecutionStart/End) — richer than
//      the old onChunk-only path and correct for v7 chunk field names.
//   3. For sub-agents, returns the buffer so the caller can hand it back to
//      the Harness, which ingests it with the right agent label + parent id.
//
// WHY A SHARED RECORDER, NOT INLINE CAPTURE
// Identical event shape across harness + sub-agents means the UI renders one
// consistent transcript. Sub-agents never write to their own SQLite (each DO
// has a separate DB); they return events on the RPC response and the Harness
// owns the single trace_events store.
// =============================================================================

import type {
  TraceEventInput,
  TraceEventType,
  TraceAgent,
} from "../types"

// -----------------------------------------------------------------------------
// Redaction (wires the previously-dead logging.redactToolArgs toggle)
// -----------------------------------------------------------------------------
// Walks a parsed tool-args/result object and replaces values whose key matches
// a redact list with "[redacted]". Shallow-ish: deep enough for typical tool
// args, not a full recursive scrub (args are small JSON, not nested blobs).
function redactKeys(obj: unknown, keys: string[]): unknown {
  if (obj == null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(v => redactKeys(v, keys))
  const lower = keys.map(k => k.toLowerCase())
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = lower.includes(k.toLowerCase()) ? "[redacted]" : redactKeys(v, keys)
  }
  return out
}

/** Safely stringify + redact a value for a tool args/result payload. */
function serializeToolValue(
  v: unknown,
  redactKeysList: string[],
): string | null {
  if (v == null) return null
  if (typeof v === "string") {
    // The value may itself be a JSON string (tools often JSON.stringify their
    // results). Try to parse → redact → re-stringify so a nested apiKey still
    // gets masked; fall back to the raw string.
    try {
      const parsed = JSON.parse(v)
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(redactKeys(parsed, redactKeysList))
      }
    } catch {
      // not JSON — leave as-is
    }
    return v
  }
  try {
    return JSON.stringify(redactKeys(v, redactKeysList))
  } catch {
    return String(v)
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null
}

// -----------------------------------------------------------------------------
// Sub-agent trace extraction
// -----------------------------------------------------------------------------
// Delegating tools (discover_jobs, research, write_cover_letter) return their
// result as a JSON string. A sub-agent embeds its buffered inner-loop events
// under a `__trace` key in that object. We pull it out (to ingest as nested
// events) and strip it (so the persisted tool_result payload isn't bloated by
// a duplicate copy of the same events).
type ParsedToolResult = {
  __trace?: { agent: TraceAgent; events: TraceEventInput[] }
  [k: string]: unknown
}

function parseToolResult(value: unknown): ParsedToolResult | null {
  if (value == null) return null
  // Tools return JSON.stringify(result); undo that first.
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object") return parsed as ParsedToolResult
    } catch {
      return null
    }
    return null
  }
  if (typeof value === "object") return value as ParsedToolResult
  return null
}

function extractSubTrace(
  value: unknown,
): { agent: TraceAgent; events: TraceEventInput[] } | null {
  const parsed = parseToolResult(value)
  const t = parsed?.__trace
  if (t && Array.isArray(t.events) && t.events.length > 0 && t.agent) {
    return { agent: t.agent, events: t.events }
  }
  return null
}

/** Return the tool result with the __trace key removed (deep-ish clone). */
function stripSubTrace(value: unknown): unknown {
  const parsed = parseToolResult(value)
  if (!parsed || !parsed.__trace) return value // nothing to strip
  const rest: Record<string, unknown> = { ...parsed }
  delete rest.__trace
  // Re-stringify if the original was a string (preserve the tool's contract).
  return typeof value === "string" ? JSON.stringify(rest) : rest
}

// =============================================================================
// TraceRecorder
// =============================================================================

export interface TraceRecorderOptions {
  /** Which agent owns this LLM call — drives UI color + attribution. */
  agent: TraceAgent
  /** Run id (the harness-level run that triggered this call). */
  runId: string
  /** redactKeys list from observability-config.json → logging.redactToolArgs. */
  redactKeys?: string[]
  /**
   * Sink called for every buffered event. The Harness wires this to
   * pushTraceEvent (writes straight to SQLite). Sub-agents leave it unset and
   * read .events at the end to return on the RPC response.
   */
  sink?: (ev: TraceEventInput) => void
}

/**
 * Buffers trace events for one logical LLM call (one harness streamText turn,
 * or one sub-agent generateText loop of N steps).
 *
 * Usage:
 *   const rec = new TraceRecorder({ agent:"job-agent", runId, redactKeys, sink })
 *   await generateText({ ..., ...rec.attach() })
 *   // for sub-agents:
 *   return { ..., trace: rec.toSubAgentTrace() }
 *   // for the harness (sink already wrote each event live):
 *   // nothing more to do.
 */
export class TraceRecorder {
  readonly agent: TraceAgent
  readonly runId: string
  private readonly redact: string[]
  private readonly sink?: (ev: TraceEventInput) => void
  private buffer: TraceEventInput[] = []

  /** Per-step streaming accumulators (reasoning/text deltas → one event each). */
  private reasoningBuf = ""
  private textBuf = ""
  private currentStep: number | null = null

  constructor(opts: TraceRecorderOptions) {
    this.agent = opts.agent
    this.runId = opts.runId
    this.redact = opts.redactKeys ?? []
    this.sink = opts.sink
  }

  /** Emit one event: buffer it AND forward to the live sink if present. */
  record(ev: TraceEventInput): void {
    // Always tag with the owning agent so attribution survives ingestion.
    const tagged: TraceEventInput = { ...ev, agent: this.agent }
    this.buffer.push(tagged)
    try {
      this.sink?.(tagged)
    } catch {
      // a sink failure must never break the LLM call
    }
  }

  /** All buffered events (sub-agents return this on their RPC response). */
  get events(): TraceEventInput[] {
    return this.buffer
  }

  /** True once onStepEnd has emitted the authoritative step_end event. */
  private stepEndEmitted = false

  /** Mark that onStepEnd fired, so flushFallback knows to stay quiet. */
  private markStepEndEmitted() {
    this.stepEndEmitted = true
  }

  /** Build a SubAgentTrace for returning on an RPC response. */
  toSubAgentTrace(): { agent: TraceAgent; events: TraceEventInput[] } {
    return { agent: this.agent, events: this.buffer }
  }

  /**
   * Safety net: if onStepEnd never fired (some providers / error paths short-
   * circuit before the step completes), flush any remaining reasoning/text
   * buffers and emit a minimal step_end so the transcript never silently loses
   * the turn's output. No-op when onStepEnd already did its job.
   */
  flushFallback(
    step: number | null,
    turnStartMs: number,
    result: {
      usage?: any
      steps?: any[]
      response?: any
      finishReason?: string
      warnings?: any[]
    },
  ): void {
    // Flush leftover buffers regardless (idempotent — buffers were cleared in
    // onStepEnd if it ran).
    if (this.reasoningBuf.trim()) {
      this.record({
        runId: this.runId,
        stepNumber: step,
        eventType: "reasoning",
        role: "assistant",
        payload: this.reasoningBuf,
      })
      this.reasoningBuf = ""
    }
    if (this.textBuf.trim()) {
      this.record({
        runId: this.runId,
        stepNumber: step,
        eventType: "text",
        role: "assistant",
        payload: this.textBuf,
      })
      this.textBuf = ""
    }
    if (this.stepEndEmitted) return

    // Minimal step_end from the awaited result. We can't reconstruct
    // performance.* here (that needs onStepEnd), but usage + finishReason +
    // model are enough for the transcript to show "this turn happened".
    const usage = result.usage ?? {}
    const inDetails = usage?.inputTokenDetails ?? {}
    const outDetails = usage?.outputTokenDetails ?? {}
    this.record({
      runId: this.runId,
      stepNumber: step,
      eventType: "step_end",
      label: result.finishReason ?? null,
      payload: JSON.stringify({
        finishReason: result.finishReason,
        responseMessages: result.response?.messages ?? null,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        fallback: true,
      }),
      tokensIn: num(usage.inputTokens),
      tokensOut: num(usage.outputTokens),
      tokensReasoning: num(outDetails.reasoningTokens),
      cacheRead: num(inDetails.cacheReadTokens),
      cacheWrite: num(inDetails.cacheWriteTokens),
      durationMs: Date.now() - turnStartMs,
      model: result.response?.modelId ?? null,
    })
  }

  // -------------------------------------------------------------------------
  // Explicit emission helpers (used by both harness + sub-agents)
  // -------------------------------------------------------------------------

  recordRunStart(goal: string, maxSteps: number, tokenBudget: number) {
    this.record({
      runId: this.runId,
      eventType: "run_start",
      payload: JSON.stringify({ goal, maxSteps, tokenBudget }),
    })
  }

  recordSystem(label: string | null, payload: string) {
    this.record({
      runId: this.runId,
      eventType: "system",
      role: "system",
      label,
      payload,
    })
  }

  /** The messages array sent to the model for this turn (full, capped at sink). */
  recordPrompt(step: number | null, messages: unknown) {
    let payload: string
    try {
      payload = JSON.stringify(messages)
    } catch {
      payload = String(messages)
    }
    this.record({
      runId: this.runId,
      stepNumber: step,
      eventType: "prompt",
      role: "user",
      payload,
    })
  }

  recordError(step: number | null, message: string) {
    this.record({
      runId: this.runId,
      stepNumber: step,
      eventType: "error",
      payload: message,
    })
  }

  // -------------------------------------------------------------------------
  // AI SDK v7 attachment — returns the callback object to spread into
  // generateText / streamText options.
  // -------------------------------------------------------------------------
  // We use THREE callbacks:
  //   onChunk          — streaming deltas (reasoning-delta / text-delta) +
  //                      the tool-call / tool-result chunks emitted as the
  //                      stream progresses.
  //   onStepEnd        — the authoritative per-step result: full usage (incl.
  //                      cache + reasoning token details), finishReason, model,
  //                      duration, performance, and a snapshot of the model's
  //                      response messages. Aliased as onStepFinish in v7.
  //   onToolExecutionStart/End — full args + full result + duration per tool,
  //                      with toolCallId so a call pairs with its result. This
  //                      is richer than the tool-call chunk (which only carries
  //                      the args the model chose) and captures the actual
  //                      executed output.
  //
  // v7 FIELD-NAME NOTES (these were bugs in the old onChunk):
  //   - text-delta / reasoning-delta carry `chunk.text`, NOT `chunk.textDelta`.
  //   - a tool-result part's output is `part.output`, NOT `part.result`.
  // -------------------------------------------------------------------------
  attach(stepNumber?: number): {
    onChunk: (ctx: { chunk: any }) => void
    onStepEnd: (ctx: any) => void
    onToolExecutionStart: (ctx: any) => void
    onToolExecutionEnd: (ctx: any) => void
  } {
    const self = this
    return {
      onChunk({ chunk }: { chunk: any }) {
        try {
          self.onChunk(chunk, stepNumber ?? null)
        } catch {
          // never let trace capture crash the stream
        }
      },
      onStepEnd(ctx: any) {
        try {
          self.onStepEnd(ctx, stepNumber ?? null)
        } catch {
          // swallow
        }
      },
      onToolExecutionStart(ctx: any) {
        try {
          self.onToolExecutionStart(ctx, stepNumber ?? null)
        } catch {
          // swallow
        }
      },
      onToolExecutionEnd(ctx: any) {
        try {
          self.onToolExecutionEnd(ctx, stepNumber ?? null)
        } catch {
          // swallow
        }
      },
    }
  }

  // -------------------------------------------------------------------------
  // Internal chunk / step / tool handlers
  // -------------------------------------------------------------------------

  private onChunk(chunk: any, stepFallback: number | null) {
    const step = this.currentStep ?? stepFallback
    switch (chunk?.type) {
      case "text-delta":
        // v7: chunk.text (the old code read chunk.textDelta → undefined)
        if (typeof chunk.text === "string") this.textBuf += chunk.text
        break
      case "reasoning-delta":
        if (typeof chunk.text === "string") this.reasoningBuf += chunk.text
        break
      case "tool-call": {
        // Streaming tool-call chunk: carries the parsed args once the model
        // finishes emitting them. We record it for live visibility; the
        // authoritative tool event comes from onToolExecutionEnd (with the
        // actual executed result + duration).
        const toolCallId = chunk.toolCallId ?? null
        const args = serializeToolValue(chunk.input ?? chunk.args, this.redact)
        this.record({
          runId: this.runId,
          stepNumber: step,
          eventType: "tool_call",
          label: chunk.toolName ?? null,
          toolCallId,
          payload: args,
        })
        break
      }
      // tool-result chunk is redundant with onToolExecutionEnd on most
      // providers; we let onToolExecutionEnd be the source of truth and skip
      // it here to avoid duplicate rows.
      default:
        break
    }
  }

  private onToolExecutionStart(ctx: any, step: number | null) {
    const tc = ctx?.toolCall
    if (!tc?.toolName) return
    // We already recorded the call from the tool-call chunk; nothing to add
    // at start beyond marking the current step for delta attribution.
    this.currentStep = step
  }

  private onToolExecutionEnd(ctx: any, step: number | null) {
    const tc = ctx?.toolCall
    const toolCallId = tc?.toolCallId ?? null
    const toolName = tc?.toolName ?? null
    const result = ctx?.toolOutput
    // toolOutput is a discriminated union: { type:"tool-result", output } on
    // success, { type:"tool-error", error } on failure.
    const ok = result?.type !== "tool-error"
    const value = ok ? result?.output : result?.error

    // ── Sub-agent trace ingestion ────────────────────────────────────────
    // Delegating tools (discover_jobs, research, write_cover_letter) embed a
    // `__trace` field in their result carrying the sub-agent's buffered inner-
    // loop events. We ingest those here — nested under THIS toolCallId — so
    // the transcript shows what happened inside the sub-agent (its prompts,
    // reasoning, its own tool calls, its tokens). The agent label comes from
    // the __trace, not this recorder's agent.
    const subTrace = extractSubTrace(value)
    if (subTrace) {
      ingestSubAgentTrace(subTrace, toolCallId ?? "", toolName ?? "", ev =>
        this.record(ev),
      )
    }

    // Strip the __trace from the persisted tool_result payload — it's now
    // represented as nested events, so keeping the full blob would double the
    // storage and confuse the UI.
    const displayValue = stripSubTrace(value)
    const payload = serializeToolValue(displayValue, this.redact)
    this.record({
      runId: this.runId,
      stepNumber: step,
      eventType: "tool_result",
      label: toolName,
      toolCallId,
      payload,
      durationMs: typeof ctx?.toolExecutionMs === "number"
        ? Math.round(ctx.toolExecutionMs)
        : null,
    })
  }

  private onStepEnd(step: any, stepFallback: number | null) {
    const stepNumber = step?.stepNumber ?? stepFallback
    this.currentStep = stepNumber
    this.markStepEndEmitted()

    // Flush the streamed reasoning/text buffers as single events (one per
    // step, not one per token). These are the model's chain-of-thought and
    // final text answer.
    if (this.reasoningBuf.trim()) {
      this.record({
        runId: this.runId,
        stepNumber,
        eventType: "reasoning",
        role: "assistant",
        payload: this.reasoningBuf,
      })
    }
    if (this.textBuf.trim()) {
      this.record({
        runId: this.runId,
        stepNumber,
        eventType: "text",
        role: "assistant",
        payload: this.textBuf,
      })
    }
    this.reasoningBuf = ""
    this.textBuf = ""

    // ── Authoritative step_end: full usage + finishReason + model + perf ──
    // step here is a full StepResult (GenerateTextStepEndEvent = StepResult in
    // v7). It carries everything: usage (with inputTokenDetails cache +
    // outputTokenDetails reasoning), response.modelId, response.headers,
    // performance (TTFT, tok/s, toolExecutionMs map), warnings, and the
    // responseMessages snapshot.
    const usage = step?.usage ?? {}
    const inDetails = usage?.inputTokenDetails ?? {}
    const outDetails = usage?.outputTokenDetails ?? {}
    const model = step?.response?.modelId ?? step?.model?.modelId ?? null
    const finishReason = step?.finishReason ?? null

    // Snapshot the model's response messages (the canonical "response gotten")
    // so the transcript can show exactly what came back, including structured
    // tool-call parts. Capped + truncated-flagged at the sink (pushTraceEvent).
    const responseMessages = step?.response?.messages ?? null

    const perf = step?.performance ?? {}
    const warnings = Array.isArray(step?.warnings) ? step.warnings : []

    const payload = {
      finishReason,
      responseMessages,
      performance: {
        stepTimeMs: num(perf.stepTimeMs),
        responseTimeMs: num(perf.responseTimeMs),
        timeToFirstOutputMs: num(perf.timeToFirstOutputMs),
        effectiveOutputTokensPerSecond: num(
          perf.effectiveOutputTokensPerSecond,
        ),
        outputTokensPerSecond: num(perf.outputTokensPerSecond),
        toolExecutionMs: perf.toolExecutionMs ?? {},
      },
      warnings,
    }

    this.record({
      runId: this.runId,
      stepNumber,
      eventType: "step_end",
      label: finishReason,
      payload: JSON.stringify(payload),
      tokensIn: num(usage.inputTokens),
      tokensOut: num(usage.outputTokens),
      tokensReasoning: num(outDetails.reasoningTokens),
      cacheRead: num(inDetails.cacheReadTokens),
      cacheWrite: num(inDetails.cacheWriteTokens),
      durationMs: num(perf.stepTimeMs),
      model,
    })
  }
}

// =============================================================================
// Helpers for ingesting a sub-agent's returned trace into the harness store
// =============================================================================

/**
 * Ingest a SubAgentTrace (returned by a sub-agent on its RPC response) into the
 * harness's trace_events via the provided sink. Each sub-agent event is written
 * with its original `agent` label plus parentId/parentLabel so it nests under
 * the delegating tool call in the transcript.
 *
 * `parentToolCallId` is the toolCallId of the harness tool that delegated
 * (e.g. the discover_jobs call); `parentLabel` is that tool's name.
 */
export function ingestSubAgentTrace(
  sub: { agent: TraceAgent; events: TraceEventInput[] } | undefined | null,
  parentToolCallId: string,
  parentLabel: string,
  sink: (ev: TraceEventInput) => void,
): void {
  if (!sub?.events?.length) return
  for (const ev of sub.events) {
    sink({
      ...ev,
      agent: sub.agent,
      parentId: parentToolCallId,
      parentLabel,
    })
  }
}

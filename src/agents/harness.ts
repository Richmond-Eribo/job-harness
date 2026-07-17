import { Agent, callable } from "agents"
import { generateText, streamText, isStepCount } from "ai"
import { getModel, getModelInfo, getParams, setModelOverride } from "../llm"
// import type { TraceEntry } from "../utils/trace"
import obsConfig from "../config/observability-config.json"
import { DEFAULT_HARNESS_STATE } from "../types"
import type {
  Env,
  HarnessStatus,
  HarnessState,
  Plan,
  PlanStep,
  StepLogEntry,
  DailySummary,
  ScheduleEntry,
  TraceEvent,
  TraceEventInput,
  TraceEventType,
  TraceAgent,
  SubAgentTrace,
  UserMemory,
} from "../types"
import { execSql } from "../db/db"
import type { SqlAgent, SqlValue } from "../db/db"
import {
  validateCron,
  previousFire,
  nextFire,
  describeCron,
} from "../utils/cron"
import { generateRunId, summarizeStep } from "../utils/run"
import { extractTrace } from "../utils/trace"
import type { TraceEntry } from "../utils/trace"
import {
  TraceRecorder,
  ingestSubAgentTrace,
} from "../utils/trace-recorder"
import { buildSystemPrompt, buildKickoffMessage } from "./prompt"
import { buildAgentTools } from "../tools"

// =============================================================================
// Database initialization — Harness-owned schema.
// =============================================================================

export function initDb(agent: SqlAgent) {
  // NOTE: The Agent SDK's sql tagged template executes ONE statement per call.
  // Multi-statement strings are not supported, so each CREATE TABLE is separate.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS step_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      step_number INTEGER,
      action TEXT,
      input TEXT,
      output TEXT,
      agent TEXT DEFAULT 'harness',
      tokens_used INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      date TEXT,
      goal TEXT,
      focus TEXT DEFAULT 'all',
      summary TEXT,
      decisions TEXT,
      steps_taken INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cron TEXT NOT NULL,
      focus TEXT DEFAULT 'all',
      enabled INTEGER DEFAULT 1,
      last_triggered_at TEXT
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  )

  // v2 trace columns — additive ALTER TABLE guarded by pragma table_info so
  // runs are idempotent across restarts. Legacy rows have NULL for these.
  ensureColumn(agent, "step_log", "reasoning", "TEXT")
  ensureColumn(agent, "step_log", "text_out", "TEXT")
  ensureColumn(agent, "step_log", "prompt_tokens", "INTEGER")
  ensureColumn(agent, "step_log", "completion_tokens", "INTEGER")
  ensureColumn(agent, "step_log", "reasoning_tokens", "INTEGER")
  ensureColumn(agent, "step_log", "duration_ms", "INTEGER")
  ensureColumn(agent, "step_log", "model", "TEXT")
  ensureColumn(agent, "step_log", "warnings", "TEXT")

  // ── v3: append-only trace_events + user_memory tables ─────────────────
  // trace_events is the hierarchical record of every model turn: prompt,
  // reasoning, text, tool calls + results, step_end usage. Supersedes the
  // flat step_log trace columns for new runs; step_log is kept for back-compat.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_number INTEGER,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      role TEXT,
      label TEXT,
      payload TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      tokens_reasoning INTEGER,
      duration_ms INTEGER,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_events (run_id, seq)`,
  )
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_trace_type ON trace_events (event_type, created_at DESC)`,
  )

  // ── v2 observability columns: attribution + nesting + cache + truncation ─
  // All additive (ensureColumn is idempotent), so existing deploys migrate in
  // place without losing rows. See src/types/trace.ts for field docs.
  //   agent        — who emitted this (harness | job-agent | research-agent)
  //   tool_call_id — pairs a tool_call to its tool_result (AI SDK toolCallId)
  //   parent_id    — toolCallId of the delegating call → sub-agent nesting key
  //   parent_label — delegating tool name (display without a join)
  //   cache_read / cache_write — prompt-cache tokens (inputTokenDetails)
  //   truncated    — 1 when the payload was sliced (UI shows a marker)
  ensureColumn(agent, "trace_events", "agent", "TEXT DEFAULT 'harness'")
  ensureColumn(agent, "trace_events", "tool_call_id", "TEXT")
  ensureColumn(agent, "trace_events", "parent_id", "TEXT")
  ensureColumn(agent, "trace_events", "parent_label", "TEXT")
  ensureColumn(agent, "trace_events", "cache_read", "INTEGER")
  ensureColumn(agent, "trace_events", "cache_write", "INTEGER")
  ensureColumn(agent, "trace_events", "truncated", "INTEGER DEFAULT 0")

  // Index for step grouping + parent nesting lookups. Dropped first to keep
  // idempotent re-runs clean (CREATE INDEX IF NOT EXISTS would also work, but
  // an explicit DROP makes the column-index intent clear in the schema).
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_trace_run_step
       ON trace_events (run_id, step_number, seq)`,
  )
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_trace_parent
       ON trace_events (run_id, parent_id, seq)`,
  )

  // user_memory: human-authored notes injected into every system prompt as a
  // high-authority layer above the agent's own context table.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS user_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )

  // ── v4: run_checkpoints — app-level crash recovery (P1b) ──────────────
  // agents@0.0.74 has no runFiber/stash (those landed later). We build the
  // same durability property at the app layer: one row per step stores the
  // conversation + plan, replaced atomically each turn. On start()/wake() we
  // check for an unfinished run with a checkpoint and resume from it instead
  // of starting fresh.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS run_checkpoints (
      run_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      step_number INTEGER NOT NULL,
      messages_json TEXT NOT NULL,
      plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      loop_state_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_checkpoint_status
       ON run_checkpoints (status, updated_at DESC)`,
  )
  // Backfill the loop_state_json column on databases created before the
  // actor-loop refactor. ensureColumn() is idempotent so this is a no-op on
  // fresh deploys.
  ensureColumn(agent, "run_checkpoints", "loop_state_json", "TEXT")
}

/**
 * Add a SQLite column if it's not already present. SQLite has no
 * IF NOT EXISTS for ALTER TABLE — we check pragma table_info first.
 * Idempotent across restarts; safe to call on every initDb().
 */
function ensureColumn(
  agent: SqlAgent,
  table: string,
  column: string,
  ddl: string,
) {
  const cols = execSql(agent, `PRAGMA table_info(${table})`)
  const exists = cols.some((c: any) => c.name === column)
  if (!exists) {
    execSql(agent, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/**
 * Resolve the payload cap (in chars) for an event type, or null for "no cap".
 * Wires the previously-dead observability toggles: reasoning/text caps come
 * from `trace.*`, tool_call/tool_result from `logging.maxToolOutputChars`, and
 * prompt/system from `logging.maxPromptChars` (default 200k — big enough that a
 * full prompt survives intact in practice, but bounded so a runaway buffer
 * can't blow up the row). Other event types (run_start, step_end, …) are small
 * JSON and left uncapped.
 */
function capForType(
  type: TraceEventType,
  maxReasoning: number,
  maxText: number,
  maxTool: number,
  maxPrompt: number,
): number | null {
  switch (type) {
    case "reasoning":
      return maxReasoning
    case "text":
      return maxText
    case "tool_call":
    case "tool_result":
      return maxTool
    case "prompt":
    case "system":
      return maxPrompt
    default:
      return null
  }
}

/**
 * Parse a JSON tool-args payload and return one field, defensively.
 * Used by notification summarizers that read LLM tool-call args.
 */
function safePick(jsonStr: string, key: string): string | null {
  try {
    const obj = JSON.parse(jsonStr)
    const v = obj?.[key]
    return v != null ? String(v).slice(0, 160) : null
  } catch {
    return null
  }
}

/**
 * Turn a run's machine stop-code into a single readable sentence for the
 * notifications dropdown. Falls back to the raw payload's `reason` field if
 * the code isn't recognized, so a new stop reason still reads sensibly.
 *
 * `code`   — the run_end event's label (the stop code)
 * `payload`— the run_end JSON, which may carry `{ reason: "..." }`
 */
function humanizeStopReason(code: string, payload: string | null): string | null {
  const map: Record<string, string> = {
    done: "Goal complete — the agent called finish.",
    max_steps_reached:
      "Hit the step ceiling before finishing. Consider raising maxSteps or narrowing the goal.",
    token_budget_reached:
      "Stopped after the token budget was spent.",
    idle_detected:
      "Stopped — no tool calls for three turns in a row.",
    repeated_loop_detected:
      "Stopped — the agent repeated the same tool call in a tight loop.",
    interrupted: "Run was interrupted by an external stop/pause call.",
    model_call_failed:
      "Model call failed — check the provider config + API key.",
    error: "Run errored out.",
  }
  if (map[code]) return map[code]
  // Fall back to the human reason embedded in the payload, if present.
  if (payload) {
    try {
      const parsed = JSON.parse(payload)
      if (typeof parsed?.reason === "string") return parsed.reason
    } catch {
      // ignore
    }
  }
  return code || null
}

/**
 * Selective retention for the in-memory conversation history.
 *
 * `messages` is the array we re-send to the LLM on every loop iteration. Tool
 * results (especially `discover_jobs`) carry large JSON payloads (~5–10KB),
 * so without pruning the prompt-token cost grows quadratically with step
 * count — by step 30 of a job-search run we were re-sending ~100KB of stale
 * listings every turn.
 *
 * Strategy: KEEP the most recent `retain` tool messages verbatim (they're
 * likely the ones the model is actively reasoning about). REPLACE older tool
 * messages' CONTENT with a short placeholder pointing the model at the tool
 * it can use to re-fetch. System / user / assistant-text turns are never
 * touched — those carry continuity, decisions, and reasoning.
 *
 * SCHEMA NOTE: AI SDK v4 tool messages are sent as
 *   { role:"tool", id, content: [{ type:"tool-result", toolCallId, toolName, result }] }
 * — content is an ARRAY of typed parts, and each part MUST keep its
 * `toolCallId` so the provider can correlate it with the assistant's
 * `tool-call`. Rewriting the array to `[{ type:"text", ... }]` makes the
 * whole conversation fail validation ("message must be a CoreMessage"). So
 * we DON'T touch the array shape — we just replace each part's `result`
 * with a short string, preserving the schema-critical keys.
 *
 * This is in-place mutation. The full, un-pruned record still lives in the
 * `trace_events` SQLite table for the dashboard's Trace view.
 */
/**
 * Per-iteration bookkeeping the agent loop used to keep in local variables.
 * Persisted into run_checkpoints.loop_state_json so the actor-loop pattern
 * (one LLM turn per alarm tick) can restore stuck-detection state across
 * ticks. Without this, pausing/stopping between ticks would reset the
 * identical-call and idle counters to zero each tick.
 */
interface LoopState {
  consecutiveIdenticalToolCalls: number
  lastToolName: string
  lastToolArgs: string
  lastToolCallAtMs: number
  consecutiveNoToolTurns: number
}

function emptyLoopState(): LoopState {
  return {
    consecutiveIdenticalToolCalls: 0,
    lastToolName: "",
    lastToolArgs: "",
    lastToolCallAtMs: 0,
    consecutiveNoToolTurns: 0,
  }
}

const IDENTICAL_TOOL_LIMIT = 3
const IDENTICAL_TOOL_WINDOW_MS = 60_000 // <60s between identical calls = suspicious

function compactToolResults(messages: any[], retain: number): void {
  if (retain < 0) return

  // Extract a short string preview from any tool-result `result` value.
  const previewOf = (v: unknown): string => {
    if (typeof v === "string") return v
    if (v == null) return ""
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }

  // Collect indices of tool messages, newest-first.
  const toolMsgIdx: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "tool") toolMsgIdx.push(i)
  }
  // Anything beyond the first `retain` (i.e. older) gets its result pruned.
  for (let n = retain; n < toolMsgIdx.length; n++) {
    const idx = toolMsgIdx[n]
    const msg = messages[idx]
    if (!msg) continue

    // Tool content is one of:
    //   string                        (older AI SDK e.g. OpenAI raw)
    //   array of tool-result parts    (AI SDK v7 typed shape)
    // Handle both, and preserve whichever shape we received. NOTE: the v7
    // ToolResultPart field is `output` (v4 was `result`); read both so this
    // works across SDK versions.
    const content = msg.content
    if (Array.isArray(content)) {
      msg.content = content.map((part: any) => {
        if (part && part.type === "tool-result") {
          const orig = previewOf(part.output ?? part.result)
            .replace(/\s+/g, " ")
            .trim()
          const placeholder =
            `[pruned to save context — call pipeline_status, list_jobs, or recall to re-fetch. ` +
            `was: ${orig.slice(0, 60)}${orig.length > 60 ? "…" : ""}]`
          return {
            ...part,
            output: placeholder,
            result: placeholder,
          }
        }
        // Non-result parts (rare on tool messages) left alone
        return part
      })
    } else if (typeof content === "string") {
      const orig = content.replace(/\s+/g, " ").trim()
      msg.content =
        `[pruned to save context — call pipeline_status, list_jobs, or recall to re-fetch. ` +
        `was: ${orig.slice(0, 60)}${orig.length > 60 ? "…" : ""}]`
    }
    // else: defensive — leave untouched
  }
}

// =============================================================================
// Harness class
// =============================================================================

export class Harness extends Agent<Env, HarnessState> {
  initialState: HarnessState = DEFAULT_HARNESS_STATE

  private dbInitialized = false

  // Monotonic per-run event sequence. In-memory cache of the high-water seq
  // for the active run; reseeded from the DB on run start / resume so an
  // evicted DO (which would reset this field to 0) cannot produce duplicate
  // seq values within one logical run.
  private traceSeq = 0
  private traceSeqRunId: string | null = null

  /**
   * Compute the next seq for a run from the DB's high-water mark. Used to
   * reseed `traceSeq` on run start / resume so eviction can't reset it to 0
   * (which would collide with seqs already written before the eviction).
   */
  private reseedTraceSeq(runId: string): void {
    try {
      const rows = execSql(
        this,
        `SELECT MAX(seq) AS max_seq FROM trace_events WHERE run_id = ?`,
        [runId],
      )
      const max = (rows[0] as any)?.max_seq
      this.traceSeq = typeof max === "number" ? max : 0
      this.traceSeqRunId = runId
    } catch {
      this.traceSeq = 0
      this.traceSeqRunId = runId
    }
  }

  /**
   * Append one row to trace_events. Caps payload length via observability
   * config (wiring the previously-dead maxToolOutputChars + maxPromptChars
   * toggles), sets `truncated` when a cap bites, and never throws — logging
   * must never crash the loop.
   *
   * If `ev.runId` differs from the cached seq-run, we reseed first so the seq
   * stays monotonic even across DO eviction + resume.
   */
  private pushTraceEvent(ev: TraceEventInput): void {
    const cap = obsConfig.trace ?? {}
    const loggingCap = obsConfig.logging ?? {}
    const maxReasoning = cap.maxReasoningChars ?? 8000
    const maxText = cap.maxTextChars ?? 16000
    const maxTool = loggingCap.maxToolOutputChars ?? 4000
    const maxPrompt = loggingCap.maxPromptChars ?? 200000

    // Reseed seq if the run changed (covers eviction → resume on a different
    // run, and the first event of a fresh run).
    if (this.traceSeqRunId !== ev.runId) this.reseedTraceSeq(ev.runId)
    const seq = ++this.traceSeq

    let payload = ev.payload ?? null
    let truncated = ev.truncated ?? 0
    if (payload != null) {
      const limit = capForType(
        ev.eventType,
        maxReasoning,
        maxText,
        maxTool,
        maxPrompt,
      )
      if (limit != null && payload.length > limit) {
        payload = payload.slice(0, limit)
        truncated = 1
      }
    }

    try {
      execSql(
        this,
        `INSERT INTO trace_events
          (run_id, step_number, seq, event_type, role, label, payload,
           tokens_in, tokens_out, tokens_reasoning, duration_ms, model,
           agent, tool_call_id, parent_id, parent_label,
           cache_read, cache_write, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.runId,
          ev.stepNumber ?? null,
          seq,
          ev.eventType,
          ev.role ?? null,
          ev.label ?? null,
          payload,
          ev.tokensIn ?? null,
          ev.tokensOut ?? null,
          ev.tokensReasoning ?? null,
          ev.durationMs ?? null,
          ev.model ?? null,
          ev.agent ?? "harness",
          ev.toolCallId ?? null,
          ev.parentId ?? null,
          ev.parentLabel ?? null,
          ev.cacheRead ?? null,
          ev.cacheWrite ?? null,
          truncated,
        ],
      )
    } catch {
      // never crash the loop on logging
    }
  }

  // ---------------------------------------------------------------------------
  // Checkpoint / recovery (P1b) — app-level durability
  // ---------------------------------------------------------------------------
  // agents@0.0.74 has no runFiber/stash/onFiberRecovered primitives. We build
  // the same property at the app layer using the DO's own SQLite: one row per
  // run stores the latest conversation + plan, overwritten every turn. On
  // start()/wake() we probe for a checkpoint that belongs to a run whose
  // status is still "running" (i.e. never marked done/errored) and resume
  // from it instead of starting fresh. This recovers from eviction, crash,
  // and accidental redeploy mid-run.
  //
  // The checkpoint covers the IN-MEMORY variables the loop relies on: the
  // running `messages` array, current step number, and the plan. Any other
  // loop-local bookkeeping (toolName history, delta buffers) is reconstructed
  // from the restored messages — losing the stuck-detection counters across a
  // restart means we may let one extra identical call through before flagging
  // it; acceptable.

  private writeCheckpoint(
    runId: string,
    goal: string,
    stepNumber: number,
    messages: any[],
    plan: Plan | null,
    loopState?: LoopState,
  ): void {
    try {
      // Cap the messages JSON so a runaway buffer can't blow up the row.
      const messagesJson = JSON.stringify(messages).slice(0, 1024 * 1024)
      const planJson = plan ? JSON.stringify(plan) : null
      const loopStateJson = loopState ? JSON.stringify(loopState) : null
      execSql(
        this,
        `INSERT INTO run_checkpoints (run_id, goal, step_number, messages_json, plan_json, status, loop_state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, datetime('now'))
         ON CONFLICT(run_id) DO UPDATE SET
           step_number = excluded.step_number,
           messages_json = excluded.messages_json,
           plan_json = excluded.plan_json,
           status = 'running',
           loop_state_json = excluded.loop_state_json,
           updated_at = datetime('now')`,
        [runId, goal, stepNumber, messagesJson, planJson, loopStateJson],
      )
    } catch {
      // never let checkpoint writes crash the loop
    }
  }

  private markCheckpoint(
    runId: string,
    status: "done" | "error" | "interrupted",
  ): void {
    try {
      execSql(
        this,
        `UPDATE run_checkpoints SET status = ?, updated_at = datetime('now')
         WHERE run_id = ?`,
        [status, runId],
      )
    } catch {
      // swallow
    }
  }

  /**
   * Find the most recent unfinished run's checkpoint. Returns null if no
   * resumable run exists. Used by start()/wake() to decide whether to resume
   * or begin a fresh run.
   */
  private findResumableCheckpoint(): {
    runId: string
    goal: string
    stepNumber: number
    messages: any[]
    plan: Plan | null
    loopState: LoopState
    updatedAt: string
  } | null {
    try {
      const rows = execSql(
        this,
        `SELECT run_id, goal, step_number, messages_json, plan_json, loop_state_json, updated_at
           FROM run_checkpoints
          WHERE status = 'running'
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      if (rows.length === 0) return null
      const r = rows[0] as any
      let messages: any[] = []
      try {
        messages = JSON.parse(r.messages_json as string)
      } catch {
        return null // corrupt checkpoint — start fresh
      }
      let plan: Plan | null = null
      try {
        if (r.plan_json) plan = JSON.parse(r.plan_json as string)
      } catch {
        // plan optional
      }
      let loopState: LoopState = emptyLoopState()
      try {
        if (r.loop_state_json) {
          const parsed = JSON.parse(r.loop_state_json as string)
          loopState = { ...emptyLoopState(), ...parsed }
        }
      } catch {
        // loop_state optional — defaults are safe
      }
      return {
        runId: r.run_id as string,
        goal: r.goal as string,
        stepNumber: r.step_number as number,
        messages,
        plan,
        loopState,
        updatedAt: r.updated_at as string,
      }
    } catch {
      return null
    }
  }

  // NOTE: stream-chunk handling (reasoning/text/tool deltas → trace_events) and
  // the per-step reasoning/text buffers used to live here as onChunk +
  // reasoningBuf/textBuf. They moved into the shared TraceRecorder
  // (src/utils/trace-recorder.ts) so the SAME capture path serves the harness
  // streamText loop AND the sub-agent generateText loops. Two v7 bugs the old
  // onChunk had are fixed in the recorder: it reads chunk.text (not the v4
  // chunk.textDelta, which was undefined in v7 and silently dropped reasoning/
  // text capture), and it pairs tool_call ↔ tool_result via toolCallId.

  /** Exposed so tool factories (in tools/) can log + advance the step counter. */
  advanceForTool(runId: string, toolName: string, input: string | null) {
    this.setState({ ...this.state, currentStep: this.state.currentStep + 1 })
    this.logStep(runId, this.state.currentStep, toolName, input, null)
  }

  /** Exposed so the `finish` tool can persist the run summary directly. */
  finishRunPersisted(
    runId: string,
    goal: string,
    summary: string,
    decisions: string[],
    reason: string,
  ) {
    const today = new Date().toISOString().slice(0, 10)
    execSql(
      this,
      `INSERT INTO daily_summaries (run_id, date, goal, summary, decisions, steps_taken, focus)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        today,
        goal,
        `${summary}\n\n[stop_reason: ${reason}, tokens: ${this.state.tokensUsed}]`,
        JSON.stringify(decisions),
        this.state.currentStep,
        "all",
      ],
    )
    // Mark the run's checkpoint as completed so the next start() doesn't try
    // to resume from a finished run.
    this.markCheckpoint(runId, "done")
    this.setState({ ...this.state, status: "done" })
  }

  private logStep(
    runId: string,
    step: number,
    action: string,
    input: string | null,
    output: string | null,
  ) {
    try {
      execSql(
        this,
        `INSERT INTO step_log (run_id, step_number, action, input, output, agent)
         VALUES (?, ?, ?, ?, ?, 'harness')`,
        [
          runId,
          step,
          action,
          input ? input.slice(0, 2000) : null,
          output ? output.slice(0, 2000) : null,
        ],
      )
      execSql(
        this,
        `UPDATE step_log SET tokens_used = ? WHERE run_id = ? AND step_number = ?`,
        [this.state.tokensUsed || null, runId, step],
      )
    } catch {
      // Don't let logging failures crash the loop
    }
  }

  /**
   * Trace-aware step logger. Persists EVERYTHING we observed about the turn:
   * the model's reasoning (chain-of-thought), full text output, per-component
   * token usage (prompt/completion/reasoning), wall-clock duration, model id,
   * and provider warnings. Falls back to logStep() if trace capture is off.
   *
   * Reasoning/text are capped via observability-config.json so a single
   * verbose reasoning stream can't blow the SQLite row budget. Reasoning
   * capture itself is FREE in model tokens — the model produced the reasoning
   * whether we persist it or not; we only pay SQLite storage.
   */
  private logStepTrace(runId: string, t: TraceEntry) {
    const cap = obsConfig.trace ?? {}
    const { captureReasoning = true } = cap
    const maxReasoning = cap.maxReasoningChars ?? 8000
    const maxText = cap.maxTextChars ?? 16000

    try {
      const params: SqlValue[] = [
        runId,
        t.stepNumber,
        t.action,
        t.toolArgs || null,
        t.toolOutput,
        captureReasoning && t.reasoning
          ? t.reasoning.slice(0, maxReasoning)
          : null,
        t.text ? t.text.slice(0, maxText) : null,
        t.usage.promptTokens,
        t.usage.completionTokens,
        t.usage.reasoningTokens,
        t.durationMs,
        t.model,
        t.warnings.length ? JSON.stringify(t.warnings) : null,
        t.usage.totalTokens,
      ]
      execSql(
        this,
        `INSERT INTO step_log
          (run_id, step_number, action, input, output, agent,
           reasoning, text_out, prompt_tokens, completion_tokens,
           reasoning_tokens, duration_ms, model, warnings, tokens_used)
         VALUES (?, ?, ?, ?, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
      )
    } catch {
      // Worst case: fall back to the non-trace logger so the step still
      // appears in the activity log even if schema/trace columns are off.
      try {
        this.logStep(
          runId,
          t.stepNumber,
          t.action,
          t.toolArgs || null,
          t.toolOutput,
        )
      } catch {
        // truly swallow — never let logging crash the loop
      }
    }
  }

  private ensureDb() {
    if (!this.dbInitialized) {
      initDb(this)
      this.dbInitialized = true

      // Load config overrides from SQLite into live state AND apply the
      // runtime model override so PUT /api/config {llmProvider, llmModel,
      // customProviderUrl} takes effect without a redeploy. The LLM_API_KEY
      // env secret stays as-is — switching providers in the DB assumes the
      // same key works for the new provider (common for OpenAI-compatible
      // gateways); if not, swap the secret too.
      try {
        const rows = execSql(this, `SELECT key, value FROM config`)
        const cfg: Record<string, string> = {}
        for (const row of rows) cfg[row.key as string] = row.value as string

        if (cfg.goal !== undefined) {
          this.setState({ ...this.state, goal: cfg.goal })
        }
        if (cfg.maxSteps !== undefined) {
          this.setState({
            ...this.state,
            maxSteps: parseInt(cfg.maxSteps, 10) || 100,
          })
        }
        if (cfg.tokenBudget !== undefined) {
          this.setState({
            ...this.state,
            tokenBudget: parseInt(cfg.tokenBudget, 10) || 0,
          })
        }
        // Model override — any of the three keys, applied partial-ly so the
        // operator can switch just the model id (e.g. gpt-4o → gpt-4o-mini)
        // without re-specifying provider + baseURL.
        const override: Record<string, string> = {}
        if (cfg.llmProvider) override.provider = cfg.llmProvider
        if (cfg.llmModel) override.modelId = cfg.llmModel
        if (cfg.customProviderUrl)
          override.customProviderUrl = cfg.customProviderUrl
        if (Object.keys(override).length > 0) setModelOverride(override)
      } catch {
        // Config table may not have rows yet
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: start / pause / resume / stop / getStatus
  // ---------------------------------------------------------------------------

  @callable()
  async start(goal?: string): Promise<string> {
    this.ensureDb()

    if (this.state.status === "running") {
      return "Already running."
    }

    // ── Crash recovery: resume an unfinished run if one exists ──────────
    // If a previous run died (eviction, crash, redeploy) leaving a checkpoint
    // with status='running', resume that run instead of starting fresh.
    // The probe in runLoop() will restore messages + plan from the checkpoint.
    let runId: string
    let resuming = false
    const existing = this.findResumableCheckpoint()
    if (
      existing &&
      this.state.status !== "done" &&
      this.state.lastRunAt &&
      Date.now() - new Date(this.state.lastRunAt).getTime() <
        1000 * 60 * 60 * 24 // <24h old
    ) {
      runId = existing.runId
      resuming = true
      this.pushTraceEvent({
        runId,
        eventType: "system",
        label: "resume-probe",
        payload: JSON.stringify({
          reason: "found unfinished checkpoint, resuming",
          step: existing.stepNumber,
        }),
      })
    } else {
      // Auto-goal synthesis: if no goal is set anywhere, ask the model to write
      // one based on the available tools. This makes a fresh deploy useful on
      // first run without forcing the operator to set a goal first.
      let runGoal = goal ?? this.state.goal
      if (!runGoal || runGoal.trim().length === 0) {
        const synthesized = await this.synthesizeGoalFromCapabilities()
        if (synthesized) {
          runGoal = synthesized
        } else {
          runGoal =
            "Discover, rank, and apply to software / AI engineering roles that match the saved profile"
        }
      }
      runId = generateRunId()
      // Stash the run goal on `this` so the setState below picks it up.
      ;(this as any)._pendingRunGoal = runGoal
    }

    const effectiveGoal =
      (resuming ? existing?.goal : (this as any)._pendingRunGoal) ??
      goal ??
      this.state.goal

    this.setState({
      ...this.state,
      status: "running",
      currentStep: resuming ? (existing?.stepNumber ?? 0) : 0,
      tokensUsed: resuming ? this.state.tokensUsed : 0,
      runId,
      goal: effectiveGoal,
      lastRunAt: new Date().toISOString(),
      lastError: null,
    })

    // ACTOR-LOOP PATTERN (v1 gap fix): instead of awaiting a multi-minute
    // runLoop synchronously (which blocked the entire DO request queue and
    // made pause/stop dead-letter — see the v0 ANTI-PATTERN note in git
    // history), we arm ONE immediate alarm tick. Each tick runs a single
    // LLM turn, persists state, and re-arms itself with schedule(0, …).
    // Between ticks the DO is free to service /api/status, pause(), stop(),
    // etc. — pause now actually works because the next tick observes the
    // status change and exits.
    //
    // We do NOT await the run here; start() returns immediately after
    // arming. The dashboard's existing poller picks up state transitions.
    try {
      await this.schedule(0, "runLoopTick", { runId, goal: effectiveGoal })
    } catch (error: any) {
      this.setState({
        ...this.state,
        status: "error",
        lastError: error.message ?? String(error),
      })
      this.logStep(runId, this.state.currentStep, "error", null, error.message)
      this.pushTraceEvent({
        runId,
        eventType: "error",
        payload: `Run failed to arm: ${error.message ?? String(error)}`,
      })
      return `Run failed: ${error.message}`
    }

    return `Run ${runId} started (actor-loop, one turn per alarm tick).`
  }

  @callable()
  async pause(): Promise<string> {
    if (this.state.status === "running") {
      this.setState({ ...this.state, status: "paused" })
      return "Paused."
    }
    return `Cannot pause: status is "${this.state.status}"`
  }

  @callable()
  async resume(): Promise<string> {
    // ACTOR-LOOP: resume() no longer just flips status — it re-arms the
    // next tick from the checkpoint the paused tick persisted. Without this,
    // "paused → running" would have no consumer and the run would stall.
    if (this.state.status !== "paused") {
      return `Cannot resume: status is "${this.state.status}"`
    }
    this.setState({ ...this.state, status: "running" })

    const cp = this.findResumableCheckpoint()
    if (!cp || !this.state.runId) {
      // No checkpoint (e.g. paused before the first tick fired). Start fresh.
      const runId = this.state.runId ?? generateRunId()
      const goal = this.state.goal
      await this.schedule(0, "runLoopTick", { runId, goal })
      return "Resumed (fresh, no checkpoint)."
    }
    await this.schedule(0, "runLoopTick", {
      runId: cp.runId,
      goal: cp.goal,
    })
    return "Resumed."
  }

  @callable()
  async stop(): Promise<string> {
    this.setState({ ...this.state, status: "idle", currentStep: 0 })
    return "Stopped."
  }

  @callable()
  async getStatus(): Promise<HarnessState["status"]> {
    return this.state.status
  }

  @callable()
  async getFullStatus(): Promise<
    HarnessState & { model: { provider: string; model: string } }
  > {
    return { ...this.state, model: getModelInfo(this.env) }
  }

  // ---------------------------------------------------------------------------
  // wake() — the only entry the cron watchdog needs.
  // ---------------------------------------------------------------------------
  // Collapses what was previously three chatty RPCs from the Worker
  // (getStatus → checkSchedulesDue → start) into one. The harness wakes itself,
  // inspects its own state, decides whether a run is due, and starts it. This
  // restores the Managed Agents property: the harness is the decision-maker,
  // the Worker is a thin router. Early-returns if already running (race guard)
  // or if no schedule window is due.
  @callable()
  async wake(): Promise<{ ran: boolean; reason: string }> {
    this.ensureDb()

    if (this.state.status === "running") {
      return { ran: false, reason: "already running" }
    }
    if (this.state.status === "paused") {
      return { ran: false, reason: "paused" }
    }

    // status ∈ {idle, done, error} — check whether any cron window was missed
    const due = this.checkSchedulesDueInternal()
    if (!due) {
      return { ran: false, reason: "no schedule due" }
    }

    // Avoid fire-and-forget: callers (the watchdog) still want the eventual
    // completion marker for logging, so we await.
    // Auto-goal synthesis if no goal is set: same fallback as start().
    let wakeGoal = this.state.goal
    if (!wakeGoal || wakeGoal.trim().length === 0) {
      const synthesized = await this.synthesizeGoalFromCapabilities()
      if (synthesized) wakeGoal = synthesized
    }

    const runId = generateRunId()
    this.setState({
      ...this.state,
      status: "running",
      currentStep: 0,
      tokensUsed: 0,
      runId,
      goal: wakeGoal ?? this.state.goal,
      lastRunAt: new Date().toISOString(),
      lastError: null,
    })

    // ACTOR-LOOP: arm the first tick (same pattern as start()). The watchdog
    // gets an immediate "ran=true" for its log line; the run itself proceeds
    // across alarm ticks without blocking the DO queue.
    try {
      await this.schedule(0, "runLoopTick", {
        runId,
        goal: wakeGoal ?? this.state.goal,
      })
    } catch (error: any) {
      this.setState({
        ...this.state,
        status: "error",
        lastError: error.message ?? String(error),
      })
      this.logStep(runId, this.state.currentStep, "error", null, error.message)
      return {
        ran: true,
        reason: "errored: " + (error.message ?? String(error)),
      }
    }

    return { ran: true, reason: "started" }
  }

  // Internal schedule check — same logic as the public checkSchedulesDue(),
  // but does NOT need the @callable wrapper because it is only ever
  // called from inside the DO (by wake()). Keeping the two separate lets us
  // eventually drop the public callable without touching the wake contract.
  private checkSchedulesDueInternal(): boolean {
    const schedules = execSql(this, `SELECT * FROM schedules WHERE enabled = 1`)
    if (schedules.length === 0) return false

    const now = new Date()
    for (const schedule of schedules) {
      const cron = schedule.cron as string
      const id = schedule.id as number
      const prev = previousFire(cron, now)
      if (!prev) continue

      const lastTriggeredAt = schedule.last_triggered_at as string | null
      const lastMs = lastTriggeredAt ? new Date(lastTriggeredAt).getTime() : 0
      if (prev.getTime() > lastMs) {
        execSql(
          this,
          `UPDATE schedules SET last_triggered_at = datetime('now') WHERE id = ?`,
          [id],
        )
        return true
      }
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Schedule management (stored in SQLite, checked by watchdog)
  // ---------------------------------------------------------------------------

  @callable()
  async checkSchedulesDue(): Promise<boolean> {
    this.ensureDb()

    const schedules = execSql(this, `SELECT * FROM schedules WHERE enabled = 1`)

    if (schedules.length === 0) {
      // No schedules configured → the agent only runs on manual Start.
      return false
    }

    const now = new Date()

    for (const schedule of schedules) {
      const cron = schedule.cron as string
      const id = schedule.id as number

      const prev = previousFire(cron, now)
      if (!prev) continue // invalid cron — skip, never crash the watchdog

      const lastTriggeredAt = schedule.last_triggered_at as string | null
      const lastMs = lastTriggeredAt ? new Date(lastTriggeredAt).getTime() : 0

      // Catch-up / missed-run logic: if the schedule's most-recent fire time is
      // AFTER our last trigger, that window was never served → fire now.
      if (prev.getTime() > lastMs) {
        execSql(
          this,
          `UPDATE schedules SET last_triggered_at = datetime('now') WHERE id = ?`,
          [id],
        )
        return true
      }
    }

    return false
  }

  @callable()
  async addSchedule(cron: string, focus: string = "all"): Promise<string> {
    this.ensureDb()

    const normalized = cron.trim()
    const err = validateCron(normalized)
    if (err) {
      throw new Error(`Invalid cron expression "${normalized}": ${err}`)
    }

    execSql(this, `INSERT INTO schedules (cron, focus) VALUES (?, ?)`, [
      normalized,
      focus,
    ])

    return `Schedule added: "${normalized}" (focus: ${focus}) — ${describeCron(normalized)}`
  }

  @callable()
  async removeSchedule(id: number): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM schedules WHERE id = ?`, [id])
    return `Schedule ${id} removed.`
  }

  // NOTE: renamed from getSchedules() → listSchedules() → listAppSchedules().
  // `getSchedules` was reserved by the base Agent class on agents@0.0.74, and
  // `listSchedules` is now ALSO reserved on agents@0.17 (returns the DO's
  // internal alarm schedule list, with a different signature). Our app
  // schedules (cron + focus rows in the `schedules` SQLite table) are a
  // separate concept, so we use `listAppSchedules` to avoid the override
  // conflict entirely.
  @callable()
  async listAppSchedules(): Promise<ScheduleEntry[]> {
    this.ensureDb()

    const rows = execSql(this, `SELECT * FROM schedules ORDER BY id`)

    return rows.map((r: any) => {
      const cron = r.cron as string
      const enabled = r.enabled === 1
      const next = enabled ? nextFire(cron) : null
      return {
        id: r.id,
        cron,
        focus: r.focus,
        enabled,
        lastTriggeredAt: r.last_triggered_at,
        description: validateCron(cron) ? describeCron(cron) : null,
        nextFireAt: next ? next.toISOString() : null,
      }
    })
  }

  @callable()
  async toggleSchedule(id: number, enabled: boolean): Promise<string> {
    this.ensureDb()
    execSql(this, `UPDATE schedules SET enabled = ? WHERE id = ?`, [
      enabled ? 1 : 0,
      id,
    ])
    return `Schedule ${id} ${enabled ? "enabled" : "disabled"}.`
  }

  // ---------------------------------------------------------------------------
  // Config management
  // ---------------------------------------------------------------------------

  @callable()
  async updateConfig(config: Record<string, string>): Promise<string> {
    this.ensureDb()

    // Apply the model override eagerly so the next getModel() call inside the
    // loop picks it up — no need for an ensureDb() cycle.
    const modelOverride: Record<string, string> = {}

    for (const [key, value] of Object.entries(config)) {
      execSql(
        this,
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
        [key, value, value],
      )

      if (key === "goal") {
        this.setState({ ...this.state, goal: value })
      } else if (key === "maxSteps") {
        this.setState({ ...this.state, maxSteps: parseInt(value, 10) || 100 })
      } else if (key === "tokenBudget") {
        this.setState({ ...this.state, tokenBudget: parseInt(value, 10) || 0 })
      } else if (
        key === "llmProvider" ||
        key === "llmModel" ||
        key === "customProviderUrl"
      ) {
        // Map API keys → ModelConfig keys for setModelOverride.
        const mk = key === "llmModel" ? "modelId" : key
        modelOverride[mk] = value
      }
    }

    if (Object.keys(modelOverride).length > 0) {
      setModelOverride(modelOverride)
    }

    return `Config updated: ${Object.keys(config).join(", ")}`
  }

  @callable()
  async getConfig(): Promise<Record<string, string>> {
    this.ensureDb()

    const rows = execSql(this, `SELECT key, value FROM config`)

    const config: Record<string, string> = {}
    for (const row of rows) {
      config[row.key as string] = row.value as string
    }

    config.goal = this.state.goal
    config.maxSteps = String(this.state.maxSteps)
    config.tokenBudget = String(this.state.tokenBudget)
    config.tokensUsed = String(this.state.tokensUsed)
    const info = getModelInfo(this.env)
    config.llmProvider = info.provider
    config.llmModel = info.model
    config.customProviderUrl = info.endpoint ?? ""

    return config
  }

  // ---------------------------------------------------------------------------
  // Log retrieval
  // ---------------------------------------------------------------------------

  @callable()
  async getLog(limit: number = 50): Promise<StepLogEntry[]> {
    this.ensureDb()

    const rows = execSql(
      this,
      `SELECT * FROM step_log ORDER BY created_at DESC LIMIT ?`,
      [limit],
    )

    return rows.map((r: any) => ({
      id: r.id,
      runId: r.run_id,
      stepNumber: r.step_number,
      action: r.action,
      input: r.input,
      output: r.output,
      agent: r.agent ?? "harness",
      tokensUsed: r.tokens_used,
      // v2 trace fields. Legacy rows written before the schema migration have
      // NULL here; surface them as null/empty so the type stays uniform and
      // the dashboard treats them as "no trace captured" rather than crashing.
      reasoning: r.reasoning ?? null,
      text: r.text_out ?? null,
      promptTokens: r.prompt_tokens ?? null,
      completionTokens: r.completion_tokens ?? null,
      reasoningTokens: r.reasoning_tokens ?? null,
      durationMs: r.duration_ms ?? null,
      model: r.model ?? null,
      warnings: r.warnings ? JSON.parse(r.warnings || "[]") : [],
      createdAt: r.created_at,
    }))
  }

  @callable()
  async getDailySummaries(limit: number = 10): Promise<DailySummary[]> {
    this.ensureDb()

    const rows = execSql(
      this,
      `SELECT * FROM daily_summaries ORDER BY created_at DESC LIMIT ?`,
      [limit],
    )

    return rows.map((r: any) => ({
      id: r.id,
      runId: r.run_id,
      date: r.date,
      goal: r.goal,
      focus: r.focus,
      summary: r.summary,
      decisions: JSON.parse(r.decisions || "[]"),
      stepsTaken: r.steps_taken,
      createdAt: r.created_at,
    }))
  }

  // ---------------------------------------------------------------------------
  // Trace retrieval — back the dashboard's Trace tab.
  // ---------------------------------------------------------------------------
  // listRuns() derives the run list from trace_events (the canonical store
  // since v3) with a UNION against step_log so legacy runs written before the
  // trace_events table existed still appear. Each row carries enough for the
  // run-list table: start time, step count, and token totals.
  // ---------------------------------------------------------------------------

  @callable()
  async listRuns(limit: number = 20): Promise<
    Array<{
      runId: string
      createdAt: string
      steps: number
      tokens: number | null
      status: string | null
      goal: string | null
    }>
  > {
    this.ensureDb()
    // trace_events is the source of truth for new runs. We derive steps from
    // the max step_number on a step_end event (one per turn), tokens from the
    // sum of tokens_in + tokens_out on step_end events, and status/goal from
    // the run_start / run_end events.
    const rows = execSql(
      this,
      `SELECT run_id,
              MIN(created_at) AS started_at,
              COALESCE(MAX(CASE WHEN event_type='step_end' THEN step_number END), 0) AS steps,
              COALESCE(SUM(CASE WHEN event_type='step_end'
                                THEN COALESCE(tokens_in,0) + COALESCE(tokens_out,0)
                                ELSE 0 END), 0) AS tokens
         FROM trace_events
        WHERE run_id IS NOT NULL AND run_id <> ''
        GROUP BY run_id
        ORDER BY started_at DESC
        LIMIT ?`,
      [limit],
    )
    if (rows.length > 0) {
      // Pull status + goal per run from the run_start / run_end rows in one pass.
      const runIds = rows.map((r: any) => r.run_id)
      const placeholders = runIds.map(() => "?").join(",")
      let statusGoal: Record<string, { status: string | null; goal: string | null }> = {}
      try {
        const sgRows = execSql(
          this,
          `SELECT run_id,
                  MAX(CASE WHEN event_type='run_end' THEN label END) AS status,
                  MAX(CASE WHEN event_type='run_start' THEN json_extract(payload,'$.goal') END) AS goal
             FROM trace_events
            WHERE run_id IN (${placeholders}) AND event_type IN ('run_start','run_end')
            GROUP BY run_id`,
          runIds,
        )
        for (const r of sgRows) {
          statusGoal[r.run_id as string] = {
            status: (r.status as string) ?? null,
            goal: (r.goal as string) ?? null,
          }
        }
      } catch {
        // json_extract may be unavailable on very old SQLite; status/goal stay null
      }
      return rows.map((r: any) => ({
        runId: r.run_id as string,
        createdAt: r.started_at as string,
        steps: (r.steps as number) ?? 0,
        tokens: (r.tokens as number) ?? null,
        status: statusGoal[r.run_id as string]?.status ?? null,
        goal: statusGoal[r.run_id as string]?.goal ?? null,
      }))
    }
    // Fallback for runs that pre-date the trace_events table entirely.
    const legacy = execSql(
      this,
      `SELECT run_id,
              MIN(created_at) AS started_at,
              MAX(step_number) AS steps,
              MAX(tokens_used) AS tokens
         FROM step_log
        WHERE run_id IS NOT NULL
        GROUP BY run_id
        ORDER BY started_at DESC
        LIMIT ?`,
      [limit],
    )
    return legacy.map((r: any) => ({
      runId: r.run_id as string,
      createdAt: r.started_at as string,
      steps: (r.steps as number) ?? 0,
      tokens: (r.tokens as number) ?? null,
      status: null,
      goal: null,
    }))
  }

  /**
   * Metadata for one run: goal, status, startedAt, endedAt, and rolled-up
   * token totals. Backs the single-run transcript header. Derived from
   * trace_events so it reflects exactly what the dashboard will render.
   */
  @callable()
  async getRun(runId: string): Promise<{
    runId: string
    goal: string | null
    status: string | null
    startedAt: string | null
    endedAt: string | null
    steps: number
    tokensIn: number
    tokensOut: number
    tokensReasoning: number
    cacheRead: number
    cacheWrite: number
    finishReason: string | null
  }> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT
          MIN(created_at) AS started_at,
          MAX(created_at) AS ended_at,
          MAX(CASE WHEN event_type='run_end' THEN label END) AS status,
          MAX(CASE WHEN event_type='run_start' THEN json_extract(payload,'$.goal') END) AS goal,
          COALESCE(MAX(CASE WHEN event_type='step_end' THEN step_number END), 0) AS steps,
          COALESCE(SUM(CASE WHEN event_type='step_end' THEN COALESCE(tokens_in,0) END),0) AS tokens_in,
          COALESCE(SUM(CASE WHEN event_type='step_end' THEN COALESCE(tokens_out,0) END),0) AS tokens_out,
          COALESCE(SUM(CASE WHEN event_type='step_end' THEN COALESCE(tokens_reasoning,0) END),0) AS tokens_reasoning,
          COALESCE(SUM(CASE WHEN event_type='step_end' THEN COALESCE(cache_read,0) END),0) AS cache_read,
          COALESCE(SUM(CASE WHEN event_type='step_end' THEN COALESCE(cache_write,0) END),0) AS cache_write,
          MAX(CASE WHEN event_type='step_end' THEN label END) AS finish_reason
         FROM trace_events
        WHERE run_id = ?`,
      [runId],
    )
    const r = (rows[0] ?? {}) as any
    return {
      runId,
      goal: (r.goal as string) ?? null,
      status: (r.status as string) ?? null,
      startedAt: (r.started_at as string) ?? null,
      endedAt: (r.ended_at as string) ?? null,
      steps: (r.steps as number) ?? 0,
      tokensIn: Number(r.tokens_in) || 0,
      tokensOut: Number(r.tokens_out) || 0,
      tokensReasoning: Number(r.tokens_reasoning) || 0,
      cacheRead: Number(r.cache_read) || 0,
      cacheWrite: Number(r.cache_write) || 0,
      finishReason: (r.finish_reason as string) ?? null,
    }
  }

  @callable()
  async getTrace(runId: string): Promise<StepLogEntry[]> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT * FROM step_log WHERE run_id = ? ORDER BY step_number ASC`,
      [runId],
    )
    return rows.map((r: any) => ({
      id: r.id,
      runId: r.run_id,
      stepNumber: r.step_number,
      action: r.action,
      input: r.input,
      output: r.output,
      agent: r.agent ?? "harness",
      tokensUsed: r.tokens_used,
      reasoning: r.reasoning ?? null,
      text: r.text_out ?? null,
      promptTokens: r.prompt_tokens ?? null,
      completionTokens: r.completion_tokens ?? null,
      reasoningTokens: r.reasoning_tokens ?? null,
      durationMs: r.duration_ms ?? null,
      model: r.model ?? null,
      warnings: r.warnings ? JSON.parse(r.warnings || "[]") : [],
      createdAt: r.created_at,
    }))
  }

  // ---------------------------------------------------------------------------
  // Memory — human-facing access to the harness's `context` table.
  // ---------------------------------------------------------------------------
  // The harness already exposes remember/recall TOOLS for the LLM; these are
  // the DB-backed accessors the dashboard uses to render and edit the same
  // rows. Keeping them on the Harness DO means single-source-of-truth: there
  // is no separate memory service, and writes from the API and from the agent
  // hit the same schema.
  // ---------------------------------------------------------------------------

  @callable()
  async getAllMemory(): Promise<
    Array<{ key: string; value: string; updatedAt: string }>
  > {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT key, value, updated_at FROM context ORDER BY updated_at DESC`,
    )
    return rows.map((r: any) => ({
      key: r.key as string,
      value: r.value as string,
      updatedAt: r.updated_at as string,
    }))
  }

  @callable()
  async setMemory(key: string, value: string): Promise<string> {
    this.ensureDb()
    execSql(
      this,
      `INSERT INTO context (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      [key, value, value],
    )
    return `Remembered ${key}.`
  }

  @callable()
  async forgetMemory(key: string): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM context WHERE key = ?`, [key])
    return `Forgot ${key}.`
  }

  // ---------------------------------------------------------------------------
  // The agent loop (Anthropic "Autonomous Agent" pattern)
  // ---------------------------------------------------------------------------
  // Explicit while-loop (not buried inside a single generateText({maxSteps}) call)
  // so the agent's planning and the tool feedback it reacted to are visible in
  // step_log. Three stopping conditions are checked every iteration: maxSteps,
  // tokenBudget, and the agent calling `finish`.
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // ACTOR-LOOP PATTERN (v1 gap fix)
  // -------------------------------------------------------------------------
  // Replaces the synchronous while(true) with one-iteration-per-alarm-tick.
  // Each alarm invocation runs runLoopTick(), which executes exactly ONE LLM
  // turn, then either finishes the run (stop condition / done) or re-arms
  // itself via schedule(0, "runLoopTick", …). Between ticks the DO is free
  // to service /api/status, pause(), stop(), etc. — so pause/stop now work
  // in real time rather than being queued behind the running loop.
  //
  // Per-iteration state that used to live in local vars (stuck-detection
  // counters, last tool call) is persisted in run_checkpoints.loop_state_json
  // and restored at the top of each tick. The messages array + plan are
  // restored from the same row.
  //
  // Crash recovery: an interrupted run (eviction, crash, redeploy) leaves a
  // checkpoint with status='running'. On the next wake()/start(), that
  // checkpoint is detected and the next tick resumes from it rather than
  // starting fresh.
  // -------------------------------------------------------------------------
  @callable()
  async runLoopTick(payload: { runId: string; goal: string }): Promise<void> {
    this.ensureDb()
    const { runId, goal } = payload

    // NOTE: we deliberately do NOT early-return on status !== "running" here.
    // Pause/stop checks must happen AFTER state restoration (below), so the
    // checkpoint reflects the current messages. Reading status through a
    // local avoids TypeScript narrowing the post-guard union away.
    const status = this.state.status as HarnessStatus

    if (status === "done" || status === "error") {
      // Run already finished — nothing for this tick to do.
      return
    }

    const model = getModel(this.env)
    const maxSteps = this.state.maxSteps
    const tokenBudget = this.state.tokenBudget

    // ── Restore per-run state from the checkpoint ───────────────────────
    // On the FIRST tick there's no checkpoint yet for this runId — we
    // synthesize a fresh kickoff. On later ticks we restore messages, plan,
    // and the stuck-detection state left by the previous tick.
    let messages: any[]
    let plan: Plan | null
    let loopState: LoopState
    let planNeedsFresh: boolean

    const existing = this.findResumableCheckpoint()
    const ours = existing && existing.runId === runId ? existing : null
    if (ours) {
      messages = ours.messages
      plan = ours.plan
      loopState = ours.loopState
      planNeedsFresh = false // already generated on a prior tick
    } else {
      // Fresh run — emit run_start + system events, then synthesize a plan.
      messages = [{ role: "user", content: buildKickoffMessage(goal, runId) }]
      plan = this.state.plan
      planNeedsFresh = !plan || (plan as any)._runId !== runId
      loopState = emptyLoopState()

      // Reseed the per-run seq from the DB high-water mark (covers the rare
      // case where a run_id collides with stale rows). For a genuinely fresh
      // run this sets traceSeq to 0.
      this.reseedTraceSeq(runId)
      this.pushTraceEvent({
        runId,
        eventType: "run_start",
        payload: JSON.stringify({ goal, maxSteps, tokenBudget }),
      })
    }

    if (planNeedsFresh) {
      try {
        plan = await this.generatePlan(goal)
        ;(plan as any)._runId = runId
        this.setState({ ...this.state, plan })
        this.pushTraceEvent({
          runId,
          eventType: "system",
          role: "system",
          label: "plan",
          payload: JSON.stringify(plan),
        })
      } catch {
        plan = null
      }
    }

    const tools = buildAgentTools(this, this.env, runId, goal)
    const systemPrompt = buildSystemPrompt(
      this,
      runId,
      goal,
      maxSteps,
      tokenBudget,
      plan,
    )

    // On a fresh run, snapshot the system prompt for traceability. (On a
    // resumed run it's identical — don't write it twice.)
    if (!ours) {
      this.pushTraceEvent({
        runId,
        eventType: "system",
        role: "system",
        payload: systemPrompt,
      })
    }

    // ── Trace recorder for this tick ────────────────────────────────────
    // One recorder per LLM turn. Its sink writes straight to trace_events via
    // pushTraceEvent, so events appear live on the dashboard as they stream.
    // The redactKeys list (from observability-config.json → logging) masks
    // secret-ish values in tool args/results.
    const recorder = new TraceRecorder({
      agent: "harness",
      runId,
      redactKeys: obsConfig.logging?.redactToolArgs ?? [],
      sink: ev => this.pushTraceEvent(ev),
    })

    // ── Stop conditions — checked at the TOP of each tick ───────────────
    if (this.state.currentStep >= maxSteps) {
      await this.finishRunAuto(
        runId,
        goal,
        `Stopped after reaching maxSteps (${maxSteps}). The agent was still working; consider raising the limit or narrowing the goal.`,
        "max_steps_reached",
      )
      return
    }
    if (tokenBudget > 0 && this.state.tokensUsed >= tokenBudget) {
      await this.finishRunAuto(
        runId,
        goal,
        `Stopped after token budget (${tokenBudget}) was spent. Spent ${this.state.tokensUsed}.`,
        "token_budget_reached",
      )
      return
    }
    // Pause/stop arrived via a concurrent RPC between ticks. Read through the
    // broad-typed local so these comparisons aren't narrowed away by TS.
    const statusNow = this.state.status as HarnessStatus
    if (statusNow === "paused") {
      // Pause holds the checkpoint so resume() can continue. Write the
      // current loop state so we don't reset stuck detection on resume.
      this.writeCheckpoint(
        runId,
        goal,
        this.state.currentStep,
        messages,
        plan,
        loopState,
      )
      this.pushTraceEvent({
        runId,
        eventType: "system",
        label: "paused",
        payload: "Tick observed status=paused; checkpoint saved for resume.",
      })
      return
    }
    if (statusNow !== "running") {
      // stop() set status to idle — treat as interrupted.
      await this.finishRunAuto(
        runId,
        goal,
        `Run interrupted by external ${statusNow}() call.`,
        "interrupted",
      )
      return
    }

    // ── Snapshot the prompt for this turn ───────────────────────────────
    // The recorder captures the FULL messages array (capped + truncation-flagged
    // at the sink via maxPromptChars) — not the old hardcoded 16k mid-JSON slice.
    recorder.recordPrompt(this.state.currentStep, messages)

    const turnStart = Date.now()
    const currentStepNumber = this.state.currentStep

    // ── One LLM turn, streamed so the dashboard can see progress live ───
    // The recorder's attach() spreads onChunk / onStepEnd /
    // onToolExecutionStart / onToolExecutionEnd into streamText. Each event
    // flows straight to trace_events via the recorder's sink (pushTraceEvent),
    // so reasoning / text / tool_call / tool_result / step_end are all
    // captured with the correct agent label + toolCallId pairing — no longer
    // the ad-hoc onChunk-only path that dropped reasoning/text silently
    // (v7 field name is chunk.text, not chunk.textDelta).
    let result
    // streamText surfaces provider errors as a stream part { type:"error",
    // errorText } (NOT a throw), and via the onError callback. We capture both:
    // onError logs it to the trace, and streamErrorText lets us stop the run
    // after the loop instead of silently re-arming forever. Without this, a
    // persistent provider failure (bad endpoint, 404, auth) leaves status stuck
    // at "running" with zero progress — the bug where "running" never errors.
    let streamErrorText: string | null = null
    try {
      result = streamText({
        model,
        tools,
        system: systemPrompt,
        messages,
        stopWhen: isStepCount(1),
        ...getParams(this.env),
        ...recorder.attach(currentStepNumber),
        onError: ({ error }: any) => {
          const msg = String(error?.message ?? error)
          recorder.recordError(currentStepNumber, msg)
          if (!streamErrorText) streamErrorText = msg
        },
      })
      for await (const part of result.fullStream) {
        // Watch for the error stream part — the canonical signal that the
        // model call failed. (onError is the secondary signal.)
        if (part?.type === "error" && !streamErrorText) {
          streamErrorText =
            (part as any).errorText ?? "stream error (no detail)"
        }
      }
    } catch (err: any) {
      // Thrown errors (e.g. a non-OK fetch before streaming starts) take the
      // same hard-stop path as stream errors below.
      streamErrorText = err?.message ?? String(err)
    }

    // ── Hard stop on any model-call failure ─────────────────────────────
    // A persistent provider error (404, auth, network) must flip the run to
    // "error" and NOT re-arm the next tick. Otherwise the actor-loop spins
    // forever: status="running", step=0, tokensUsed=0, no tool calls, re-arming
    // every tick into the same failing call. We resolve finishReason too, since
    // the SDK sets it to "error" on failure — either signal is sufficient.
    let resolvedFinishReason: any = undefined
    try {
      resolvedFinishReason = await result!.finishReason
    } catch {
      resolvedFinishReason = "error"
    }
    if (streamErrorText || resolvedFinishReason === "error") {
      const msg =
        streamErrorText ?? "model call failed (finishReason=error, no detail)"
      recorder.recordError(currentStepNumber, msg)
      this.logStep(runId, currentStepNumber, "llm_error", null, msg)
      // finishRunAuto emits run_end + marks the checkpoint done, so the run
      // won't try to resume from a failed tick.
      await this.finishRunAuto(
        runId,
        goal,
        `Run stopped: model call failed — ${msg}`,
        "model_call_failed",
      )
      this.setState({
        ...this.state,
        status: "error",
        lastError: msg,
      })
      return
    }

    const resolvedText = await result!.text
    const resolvedUsage = await result!.usage
    const resolvedWarnings = await result!.warnings
    const resolvedResponse = await result!.response
    const resolvedSteps = await result!.steps

    // The recorder already emitted reasoning / text / step_end events from its
    // onStepEnd handler. We keep awaiting the result fields below ONLY for the
    // loop's own bookkeeping (stuck detection, token accumulation, step_log).
    // If onStepEnd didn't fire (e.g. an early stream error left buffers full),
    // flush them as a fallback so nothing is lost.
    recorder.flushFallback(currentStepNumber, turnStart, {
      usage: resolvedUsage,
      steps: resolvedSteps,
      response: resolvedResponse,
      finishReason: resolvedFinishReason,
      warnings: resolvedWarnings,
    })

    const used = resolvedUsage?.totalTokens ?? 0
    if (used > 0) {
      this.setState({
        ...this.state,
        tokensUsed: this.state.tokensUsed + used,
      })
    }

    // ---- finish() tool ended the run ----
    if ((this.state.status as HarnessStatus) === "done") {
      return
    }

    // ---- Stuck detection (stateful across ticks via loopState) ----
    const resultLike = {
      steps: resolvedSteps,
      text: resolvedText,
      usage: resolvedUsage,
      response: resolvedResponse,
      warnings: resolvedWarnings,
      finishReason: resolvedFinishReason,
    }
    const stepSummary = summarizeStep(resultLike)
    const toolName = stepSummary.toolName
    const toolArgs = stepSummary.toolArgs

    if (!toolName) {
      loopState.consecutiveNoToolTurns++
      if (loopState.consecutiveNoToolTurns >= 3) {
        await this.finishRunAuto(
          runId,
          goal,
          "Stopped: the agent produced no tool calls for three turns in a row (idle/stuck). " +
            (resolvedText || ""),
          "idle_detected",
        )
        return
      }
    } else {
      loopState.consecutiveNoToolTurns = 0
    }

    if (toolName) {
      const now = Date.now()
      const argsMatch =
        toolName === loopState.lastToolName &&
        toolArgs === loopState.lastToolArgs
      if (argsMatch) {
        const elapsed = now - loopState.lastToolCallAtMs
        if (elapsed < IDENTICAL_TOOL_WINDOW_MS) {
          loopState.consecutiveIdenticalToolCalls++
        } else {
          loopState.consecutiveIdenticalToolCalls = 1
        }
        if (loopState.consecutiveIdenticalToolCalls >= IDENTICAL_TOOL_LIMIT) {
          await this.finishRunAuto(
            runId,
            goal,
            `Stopped: ${IDENTICAL_TOOL_LIMIT} identical calls to ${toolName} within ${IDENTICAL_TOOL_WINDOW_MS / 1000}s — likely a tight loop.`,
            "repeated_loop_detected",
          )
          return
        }
      } else {
        loopState.consecutiveIdenticalToolCalls = 0
      }
      loopState.lastToolName = toolName
      loopState.lastToolArgs = toolArgs
      loopState.lastToolCallAtMs = now
    }

    const trace = extractTrace(resultLike, currentStepNumber)
    trace.durationMs = Date.now() - turnStart
    this.logStepTrace(runId, trace)

    // ---- Append the model's turn + prune stale tool results ----
    messages.push(...(resolvedResponse.messages as any[]))
    // ADAPTIVE retention: a fixed window of 4 starves the model of earlier
    // context on long runs (e.g. a 100-step discovery → cover-letter run
    // forgets everything from steps 1–96). Scale the window with run length
    // so longer runs keep more history. Policy: retain 4 baseline + 1 extra
    // per 10 steps elapsed, capped at 16 so prompt cost doesn't blow up.
    const adaptiveRetain = Math.min(
      16,
      4 + Math.floor(this.state.currentStep / 10),
    )
    compactToolResults(messages, adaptiveRetain)

    // ---- Advance step counter + checkpoint ----
    const nextStep = this.state.currentStep + 1
    this.setState({ ...this.state, currentStep: nextStep })

    // Persist everything the next tick needs. If the DO is evicted before the
    // next alarm fires, the run resumes from this point on the next wake().
    this.writeCheckpoint(runId, goal, nextStep, messages, plan, loopState)

    // ---- Re-arm the next tick ----
    // schedule(0, …) defers to the next alarm dispatch, returning control of
    // the DO to the request queue in between. That's the whole point: RPCs
    // arriving between this return and the next alarm are serviced promptly.
    try {
      await this.schedule(0, "runLoopTick", { runId, goal })
    } catch (err: any) {
      // Re-arm failed (alarm throttled, DO being torn down). Surface it so
      // the operator notices the run stalled; leave the checkpoint intact
      // so wake() resumes on the next cron tick.
      this.setState({
        ...this.state,
        status: "error",
        lastError: `re-arm failed: ${err?.message ?? String(err)}`,
      })
      this.pushTraceEvent({
        runId,
        eventType: "error",
        payload: `Failed to re-arm next tick: ${err?.message ?? String(err)}`,
      })
    }
  }

  private async finishRunAuto(
    runId: string,
    goal: string,
    reason: string,
    code: string,
  ): Promise<void> {
    this.pushTraceEvent({
      runId,
      eventType: "run_end",
      label: code,
      payload: JSON.stringify({ reason, code }),
    })
    this.finishRunPersisted(runId, goal, reason, [code], code)
  }

  // ---------------------------------------------------------------------------
  // v3 trace_events + user_memory RPCs
  // ---------------------------------------------------------------------------

  /** Map a trace_events SQLite row → TraceEvent, including the v2 columns. */
  private mapTraceRow(r: any): TraceEvent {
    return {
      id: r.id,
      runId: r.run_id,
      stepNumber: r.step_number ?? null,
      seq: r.seq,
      eventType: r.event_type,
      role: r.role ?? null,
      label: r.label ?? null,
      payload: r.payload ?? null,
      tokensIn: r.tokens_in ?? null,
      tokensOut: r.tokens_out ?? null,
      tokensReasoning: r.tokens_reasoning ?? null,
      durationMs: r.duration_ms ?? null,
      model: r.model ?? null,
      createdAt: r.created_at,
      // v2 columns. Legacy rows written before the migration have NULL here;
      // coalesce to safe defaults so the type stays uniform.
      agent: (r.agent ?? "harness") as TraceAgent,
      toolCallId: r.tool_call_id ?? null,
      parentId: r.parent_id ?? null,
      parentLabel: r.parent_label ?? null,
      cacheRead: r.cache_read ?? null,
      cacheWrite: r.cache_write ?? null,
      truncated: r.truncated ?? 0,
    }
  }

  @callable()
  async getTraceEvents(
    runId: string,
    sinceSeq: number = 0,
    limit: number = 500,
  ): Promise<TraceEvent[]> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT * FROM trace_events WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
      [runId, sinceSeq, limit],
    )
    return rows.map((r: any) => this.mapTraceRow(r))
  }

  @callable()
  async getRecentTraceEvents(limit: number = 200): Promise<TraceEvent[]> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT * FROM trace_events ORDER BY id DESC LIMIT ?`,
      [limit],
    )
    return rows.map((r: any) => this.mapTraceRow(r)).reverse()
  }

  // ----- user_memory (human-authored notes; high-authority prompt layer) -----

  @callable()
  async getAllUserMemory(): Promise<UserMemory[]> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT key, value, updated_at FROM user_memory ORDER BY key ASC`,
    )
    return rows.map((r: any) => ({
      key: r.key as string,
      value: r.value as string,
      updatedAt: r.updated_at as string,
    }))
  }

  @callable()
  async setUserMemory(key: string, value: string): Promise<string> {
    this.ensureDb()
    execSql(
      this,
      `INSERT INTO user_memory (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      [key, value, value],
    )
    return `Saved user note ${key}.`
  }

  @callable()
  async forgetUserMemory(key: string): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM user_memory WHERE key = ?`, [key])
    return `Removed user note ${key}.`
  }

  // ----- analytics RPCs (Overview bar chart + notifications) ----------------

  /**
   * Token spend GROUPED BY DAY. The Overview bar chart shows OUTPUT (completion)
   * tokens per day — the metric that actually grows with traffic — plus the
   * prompt + reasoning components for the stacked legend. "Per day" (not "per
   * run") is the unit because the operator wants to see spend trend over TIME,
   * which is what a bar chart is for.
   */
  @callable()
  async getTokensByDay(days: number = 14): Promise<
    Array<{
      day: string
      inTokens: number
      outTokens: number
      reasoningTokens: number
      events: number
    }>
  > {
    this.ensureDb()
    const n = Math.max(1, Math.min(days, 90))
    const rows = execSql(
      this,
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(COALESCE(tokens_in, 0))        AS in_tokens,
              SUM(COALESCE(tokens_out, 0))       AS out_tokens,
              SUM(COALESCE(tokens_reasoning, 0)) AS reasoning_tokens,
              COUNT(*)                           AS events
         FROM trace_events
        WHERE created_at >= date('now', ?)
        GROUP BY day
        ORDER BY day ASC`,
      [`-${n} days`],
    )
    return rows.map((r: any) => ({
      day: r.day as string,
      inTokens: Number(r.in_tokens) || 0,
      outTokens: Number(r.out_tokens) || 0,
      reasoningTokens: Number(r.reasoning_tokens) || 0,
      events: Number(r.events) || 0,
    }))
  }

  /**
   * Per-turn output tokens + prompt-token trend over recent step_end events.
   * Surfaces cost-growth visibility: if prompt tokens are growing fast across
   * turns, the operator can see context is bloating BEFORE the run hits the
   * wall. This is the early-warning signal for the P0a "selective retention"
   * fix's effectiveness.
   */
  @callable()
  async getTurnTokenStats(): Promise<{
    lastTurn: number | null
    maxTurn: number | null
    meanTurn: number | null
    turns: number
    promptTrend: number[] // last N step_end prompt-tokens (oldest first)
  }> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT tokens_in, tokens_out
         FROM trace_events
        WHERE event_type = 'step_end'
        ORDER BY id ASC`,
    )
    if (rows.length === 0) {
      return {
        lastTurn: null,
        maxTurn: null,
        meanTurn: null,
        turns: 0,
        promptTrend: [],
      }
    }
    const outs = rows
      .map((r: any) => Number(r.tokens_out) || 0)
      .filter(n => n > 0)
    const ins = rows.map((r: any) => Number(r.tokens_in) || 0)
    if (outs.length === 0) {
      return {
        lastTurn: null,
        maxTurn: null,
        meanTurn: null,
        turns: rows.length,
        promptTrend: ins.slice(-12),
      }
    }
    const sum = outs.reduce((a, b) => a + b, 0)
    return {
      lastTurn: outs[outs.length - 1],
      maxTurn: Math.max(...outs),
      meanTurn: Math.round(sum / outs.length),
      turns: outs.length,
      // Last 12 step_end prompt-tokens — if these are growing fast, the
      // context retention policy needs tightening.
      promptTrend: ins.slice(-12),
    }
  }

  /**
   * Notifications — recent operator-relevant happenings, derived from trace
   * events. Powers the bell dropdown. One row per notable event:
   *   run started / ended (with a human-readable stop reason)
   *   job discovery searched (with the criteria)
   *   cover letter drafted (with the company/title)
   *   agent saved a memory (with the key)
   *   error during a run (with the message)
   *
   * Each note carries runId + step so the dropdown can deep-link into the
   * transcript at the exact turn that produced it.
   */
  @callable()
  async getRecentNotifications(limit: number = 12): Promise<
    Array<{
      id: number
      kind: "run" | "job" | "cover_letter" | "error" | "memory"
      /** severity drives the row's visual weight: high = errors/stops,
       *  normal = activity, low = routine memory saves. */
      severity: "high" | "normal" | "low"
      title: string
      detail: string | null
      runId: string | null
      step: number | null
      createdAt: string
    }>
  > {
    this.ensureDb()
    const n = Math.max(1, Math.min(limit, 50))
    // Pull the event types we care about, newest first. We over-fetch (n*4)
    // because many events are filtered out (only the notable ones surface).
    const rows = execSql(
      this,
      `SELECT id, run_id, step_number, event_type, label, payload,
              tokens_out, created_at
         FROM trace_events
        WHERE event_type IN ('run_start','run_end','tool_call','tool_result','error')
        ORDER BY id DESC
        LIMIT ?`,
      [n * 4],
    )

    type Note = {
      id: number
      kind: "run" | "job" | "cover_letter" | "error" | "memory"
      severity: "high" | "normal" | "low"
      title: string
      detail: string | null
      runId: string | null
      step: number | null
      createdAt: string
    }
    const notes: Note[] = []

    for (const r of rows) {
      if (notes.length >= n) break
      const et = r.event_type as string
      const when = r.created_at as string
      const payload = r.payload as string | null
      const label = r.label as string | null
      const id = r.id as number
      const runId = (r.run_id as string) ?? null
      const step = (r.step_number as number) ?? null

      if (et === "run_start") {
        notes.push({
          id,
          kind: "run",
          severity: "normal",
          title: "Run started",
          detail: payload ? safePick(payload, "goal") ?? null : null,
          runId,
          step,
          createdAt: when,
        })
      } else if (et === "run_end") {
        // Translate the raw stop code into a readable sentence.
        const code = label ?? ""
        const reason = humanizeStopReason(code, payload)
        const isErrorStop = code === "model_call_failed" || code === "error"
        notes.push({
          id,
          kind: "run",
          severity: isErrorStop ? "high" : "normal",
          title: isErrorStop ? "Run failed" : "Run completed",
          detail: reason,
          runId,
          step,
          createdAt: when,
        })
      } else if (et === "error") {
        notes.push({
          id,
          kind: "error",
          severity: "high",
          title: "Error during run",
          detail: payload ? payload.slice(0, 160) : null,
          runId,
          step,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "discover_jobs") {
        notes.push({
          id,
          kind: "job",
          severity: "normal",
          title: "Searched for jobs",
          detail: payload ? safePick(payload, "criteria") : null,
          runId,
          step,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "write_cover_letter") {
        notes.push({
          id,
          kind: "cover_letter",
          severity: "normal",
          title: "Drafted a cover letter",
          detail: payload ? safePick(payload, "jobId") : null,
          runId,
          step,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "remember") {
        notes.push({
          id,
          kind: "memory",
          severity: "low",
          title: "Saved a memory",
          detail: payload ? safePick(payload, "key") : null,
          runId,
          step,
          createdAt: when,
        })
      }
    }
    return notes
  }

  // ----- goal RPCs (configuration shortcuts) ---------------------------------

  @callable()
  async setGoal(goal: string): Promise<string> {
    this.ensureDb()
    this.setState({ ...this.state, goal })
    execSql(
      this,
      `INSERT INTO config (key, value) VALUES ('goal', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      [goal, goal],
    )
    return `Goal set.`
  }

  // ----- plan management (P1: planning as a durability strategy) ------------

  /**
   * Have the model break the goal into concrete steps at run start. Persisted
   * to `this.state.plan` so it:
   *   • Survives eviction (Cloudflare "planning as durability strategy")
   *   • Drives "are we stuck?" — plan.currentStep must advance
   *   • Lets a recovered invocation know where it was without replaying history
   *
   * Single non-tool LLM call. Asks for strict JSON so we parse defensively;
   * if parsing fails or the model refuses, fall back to a 1-step plan equal
   * to the goal so the run still proceeds.
   */
  async generatePlan(goal: string): Promise<Plan> {
    const nowIso = new Date().toISOString()
    const fallback: Plan = {
      goal,
      steps: [
        {
          id: "step-1",
          description: goal,
          status: "in_progress",
          result: null,
        },
      ],
      currentStep: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    }

    try {
      const model = getModel(this.env)
      // Pass the FULL tool catalog (description + input schema) to the planner,
      // not just tool names. Without schemas the model can't tell whether a
      // tool takes `{topic}` vs `{criteria}` and plans against the wrong shape,
      // which degrades plan quality on the first run of a fresh deploy.
      const tools = buildAgentTools(this, this.env, "_plan-synth", goal)
      const toolCatalog = Object.entries(tools).map(
        ([name, t]: [string, any]) => ({
          name,
          description:
            typeof t?.description === "string"
              ? t.description
              : typeof t?.description === "function"
                ? "(context-dependent)"
                : "",
          inputSchema: t?.inputSchema
            ? // Best-effort: emit the schema's shape description if it's a zod
              // schema with .shape; otherwise just note it exists.
              "yes"
            : "none",
        }),
      )

      const { text } = await generateText({
        model,
        system:
          "You are a planner for an autonomous job-search agent. Break the goal into 4-6 concrete, ordered steps the agent can execute using ONLY these available tools. " +
          "Each step must be actionable in one or two tool calls. Output STRICT JSON: " +
          '{"steps":[{"id":"step-1","description":"..."},{"id":"step-2","description":"..."}]}. ' +
          "No prose, no markdown fences.",
        prompt:
          `Goal: ${goal}\n\n` +
          `Available tools (JSON):\n${JSON.stringify(toolCatalog, null, 2)}\n\n` +
          `Return the JSON plan now.`,
        ...getParams(this.env),
      })

      const trimmed = text.trim()
      const start = trimmed.indexOf("{")
      const end = trimmed.lastIndexOf("}")
      if (start !== -1 && end !== -1 && end > start) {
        const parsed = JSON.parse(trimmed.slice(start, end + 1))
        const rawSteps: any[] = Array.isArray(parsed?.steps) ? parsed.steps : []
        if (rawSteps.length > 0) {
          const steps: PlanStep[] = rawSteps.slice(0, 8).map((s, i) => ({
            id: String(s?.id ?? `step-${i + 1}`),
            description: String(s?.description ?? "(no description)"),
            status: i === 0 ? "in_progress" : "pending",
            result: null,
          }))
          return {
            goal,
            steps,
            currentStep: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          }
        }
      }
    } catch {
      // Non-fatal — fall back to the single-step plan
    }
    return fallback
  }

  @callable()
  async getPlan(): Promise<Plan | null> {
    return this.state.plan
  }

  /**
   * Mark the plan's current step as complete (or failed) and advance to the
   * next pending step. Used by:
   *   • The operator (dashboard plan-progress UI / future tool)
   *   • Recovery — onFiberRecovered resumes by re-reading plan.currentStep
   *   • `finish` tool — when the model reports step completion
   *
   * Cheap: pure setState + sqlite touch on the trace_events log.
   */
  @callable()
  async advancePlan(
    stepId: string | null,
    status: "complete" | "failed" | "skipped",
    result?: string | null,
  ): Promise<Plan | null> {
    const plan = this.state.plan
    if (!plan) return null

    const updatedSteps = plan.steps.map(s => {
      // Update the named step, OR if no id supplied, update the current step.
      const isTarget = stepId
        ? s.id === stepId
        : s.id === plan.steps[plan.currentStep]?.id
      if (!isTarget) return s
      return { ...s, status, result: result ?? s.result }
    })

    // Find the next pending step
    const nextIdx = updatedSteps.findIndex(s => s.status === "pending")
    const nextCurrentStep = nextIdx === -1 ? plan.currentStep : nextIdx

    const updatedPlan: Plan = {
      ...plan,
      steps: updatedSteps,
      currentStep: nextCurrentStep,
      updatedAt: new Date().toISOString(),
    }
    this.setState({ ...this.state, plan: updatedPlan })
    return updatedPlan
  }

  /**
   * Auto-synthesize a goal when none exists. One non-tool generateText call
   * that looks at the available tool names + today's date and writes a single
   * concrete goal. Cheaper than a full loop; only runs when no goal is set.
   *
   * P3: caches the synthesized goal in the `config` table so subsequent cold
   * starts don't pay the extra round trip on every cron tick. Once written,
   * the operator can edit it from the dashboard.
   */
  async synthesizeGoalFromCapabilities(): Promise<string | null> {
    try {
      // P3: if we already synthesized + cached a goal, skip the LLM round-trip.
      try {
        const cached = execSql(
          this,
          `SELECT value FROM config WHERE key = 'goal'`,
        )
        if (
          cached.length > 0 &&
          (cached[0].value as string)?.trim().length > 0
        ) {
          this.setState({ ...this.state, goal: cached[0].value as string })
          return cached[0].value as string
        }
      } catch {
        // config table may not exist yet — fall through to synthesis
      }

      const model = getModel(this.env)
      const toolNames = Object.keys(
        buildAgentTools(this, this.env, "_goal-synth", ""),
      ).join(", ")
      const today = new Date().toISOString().slice(0, 10)
      const { text } = await generateText({
        model,
        system:
          "You are choosing a concrete, useful goal for an autonomous job-search AI. Reply with only the goal, max 2 sentences, no preamble.",
        prompt: `Available tools: ${toolNames}. Today: ${today}. Write ONE concrete goal this agent could make daily progress on with these tools. Focus on the job-search capability. Reply with only the goal text.`,
        ...getParams(this.env),
      })
      const goal = text.trim()
      if (goal) {
        await this.setGoal(goal)
        return goal
      }
    } catch {
      // non-fatal — caller falls back to default goal
    }
    return null
  }

  /**
   * Send a tiny canned request to the configured model and return the RAW
   * shapes the AI SDK v7 exposes — so the operator can see exactly what a
   * given provider returns and design the trace rendering against reality.
   *
   * Returns: response.messages (the canonical assistant message, incl. tool-
   * call parts), full usage (input/output/reasoning + inputTokenDetails cache
   * + outputTokenDetails), response.headers (rate limits), providerMetadata,
   * finishReason, model id, and a per-step breakdown. This is the "learn what
   * each model returns" lever.
   */
  @callable()
  async probeModel(): Promise<{
    model: ReturnType<typeof getModelInfo>
    finishReason: string | null
    text: string
    usage: any
    responseMessages: any
    responseHeaders: any
    providerMetadata: any
    warnings: any[]
    steps: number
    durationMs: number
    error: string | null
  }> {
    const info = getModelInfo(this.env)
    const start = Date.now()
    try {
      const model = getModel(this.env)
      const result = await generateText({
        model,
        system:
          "You are a probe target. Reply with exactly one short sentence and nothing else.",
        prompt: "Reply with: probe ok",
        ...getParams(this.env),
      })
      return {
        model: info,
        finishReason: result.finishReason ?? null,
        text: result.text,
        usage: result.usage ?? null,
        responseMessages: result.response?.messages ?? null,
        responseHeaders: result.response?.headers ?? null,
        providerMetadata: result.providerMetadata ?? null,
        warnings: result.warnings ?? [],
        steps: result.steps?.length ?? 0,
        durationMs: Date.now() - start,
        error: null,
      }
    } catch (err: any) {
      return {
        model: info,
        finishReason: null,
        text: "",
        usage: null,
        responseMessages: null,
        responseHeaders: null,
        providerMetadata: null,
        warnings: [],
        steps: 0,
        durationMs: Date.now() - start,
        error: err?.message ?? String(err),
      }
    }
  }
}

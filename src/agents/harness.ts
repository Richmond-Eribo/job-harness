import { Agent, callable } from "agents"
import { generateText, streamText, isStepCount } from "ai"
import { getModel, getModelInfo, getParams, setModelOverride } from "../llm"
// import type { TraceEntry } from "../utils/trace"
import obsConfig from "../observability-config.json"
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
    //   array of tool-result parts    (AI SDK v4 typed shape)
    // Handle both, and preserve whichever shape we received.
    const content = msg.content
    if (Array.isArray(content)) {
      msg.content = content.map((part: any) => {
        if (part && part.type === "tool-result") {
          const orig = previewOf(part.result).replace(/\s+/g, " ").trim()
          const placeholder =
            `[pruned to save context — call pipeline_status, list_jobs, or recall to re-fetch. ` +
            `was: ${orig.slice(0, 60)}${orig.length > 60 ? "…" : ""}]`
          return { ...part, result: placeholder }
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

  // Monotonic per-run event sequence. Reset on each runLoop start.
  private traceSeq = 0

  /**
   * Append one row to trace_events. Caps payload length via observability
   * config. Never throws — logging must never crash the loop.
   */
  private pushTraceEvent(ev: TraceEventInput): void {
    const cap = obsConfig.trace ?? {}
    const maxReasoning = cap.maxReasoningChars ?? 8000
    const maxText = cap.maxTextChars ?? 16000
    const seq = ++this.traceSeq

    let payload = ev.payload ?? null
    if (payload != null) {
      // Heuristic cap: reasoning/text-heavy events are clipped; others left
      // alone (small JSON like tool args).
      if (
        (ev.eventType === "reasoning" || ev.eventType === "text") &&
        payload.length > (ev.eventType === "reasoning" ? maxReasoning : maxText)
      ) {
        payload = payload.slice(
          0,
          ev.eventType === "reasoning" ? maxReasoning : maxText,
        )
      }
    }

    try {
      execSql(
        this,
        `INSERT INTO trace_events
          (run_id, step_number, seq, event_type, role, label, payload,
           tokens_in, tokens_out, tokens_reasoning, duration_ms, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /**
   * Stream-chunk handler. Maps AI SDK v4 onChunk types → trace_events rows.
   * Accumulates reasoning/text deltas into per-step buffers so we write one
   * reasoning event and one text event per step (not one per token).
   */
  private reasoningBuf = ""
  private textBuf = ""
  private onChunk(runId: string, stepNumber: number, chunk: any): void {
    try {
      switch (chunk?.type) {
        case "tool-call":
        case "tool-call-streaming-start":
          this.pushTraceEvent({
            runId,
            stepNumber,
            eventType: "tool_call",
            label: chunk.toolName ?? null,
            payload: chunk.args
              ? JSON.stringify(chunk.args).slice(0, 4000)
              : chunk.input
                ? JSON.stringify(chunk.input).slice(0, 4000)
                : null,
          })
          break
        case "tool-result":
          this.pushTraceEvent({
            runId,
            stepNumber,
            eventType: "tool_result",
            label: chunk.toolName ?? null,
            payload:
              chunk.result != null
                ? JSON.stringify(chunk.result).slice(0, 4000)
                : null,
          })
          break
        case "reasoning-delta":
          if (typeof chunk.textDelta === "string")
            this.reasoningBuf += chunk.textDelta
          break
        case "text-delta":
          if (typeof chunk.textDelta === "string")
            this.textBuf += chunk.textDelta
          break
      }
    } catch {
      // swallow
    }
  }

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
  // listRuns() groups step_log rows by run_id to populate the run-picker.
  // getTrace(runId) returns the ordered step list for a single run, including
  // the reasoning chain-of-thought and per-component token usage. Legacy rows
  // written before the v2 migration have NULL trace fields — they surface
  // as null/empty gracefully rather than crashing the dashboard.
  // ---------------------------------------------------------------------------

  @callable()
  async listRuns(limit: number = 20): Promise<
    Array<{
      runId: string
      createdAt: string
      steps: number
      tokens: number | null
    }>
  > {
    this.ensureDb()
    const rows = execSql(
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
    return rows.map((r: any) => ({
      runId: r.run_id as string,
      createdAt: r.started_at as string,
      steps: (r.steps as number) ?? 0,
      tokens: (r.tokens as number) ?? null,
    }))
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

      this.traceSeq = 0
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
    this.pushTraceEvent({
      runId,
      stepNumber: this.state.currentStep,
      eventType: "prompt",
      role: "user",
      payload: JSON.stringify(messages).slice(0, 16000),
    })

    this.reasoningBuf = ""
    this.textBuf = ""

    const turnStart = Date.now()
    const currentStepNumber = this.state.currentStep

    // ── One LLM turn, streamed so the dashboard can see progress live ───
    let result
    try {
      result = streamText({
        model,
        tools,
        system: systemPrompt,
        messages,
        stopWhen: isStepCount(1),
        ...getParams(this.env),
        onError: ({ error }: any) => {
          this.pushTraceEvent({
            runId,
            stepNumber: currentStepNumber,
            eventType: "error",
            payload: String(error?.message ?? error),
          })
        },
        onChunk: ({ chunk }: any) => {
          this.onChunk(runId, currentStepNumber, chunk)
        },
      })
      for await (const _ of result.fullStream) {
        // consumed via onChunk above
      }
    } catch (err: any) {
      this.pushTraceEvent({
        runId,
        stepNumber: currentStepNumber,
        eventType: "error",
        payload: err?.message ?? String(err),
      })
      this.logStep(
        runId,
        currentStepNumber,
        "llm_error",
        null,
        err?.message ?? String(err),
      )
      this.setState({
        ...this.state,
        status: "error",
        lastError: err?.message ?? String(err),
      })
      return
    }

    const resolvedText = await result.text
    const resolvedUsage = await result.usage
    const resolvedWarnings = await result.warnings
    const resolvedResponse = await result.response
    const resolvedFinishReason = await result.finishReason
    const resolvedSteps = await result.steps

    if (this.reasoningBuf.trim()) {
      this.pushTraceEvent({
        runId,
        stepNumber: currentStepNumber,
        eventType: "reasoning",
        role: "assistant",
        payload: this.reasoningBuf,
      })
    }
    if (this.textBuf.trim()) {
      this.pushTraceEvent({
        runId,
        stepNumber: currentStepNumber,
        eventType: "text",
        role: "assistant",
        payload: this.textBuf,
      })
    }

    this.pushTraceEvent({
      runId,
      stepNumber: currentStepNumber,
      eventType: "step_end",
      label: resolvedFinishReason ?? null,
      payload: JSON.stringify({
        finishReason: resolvedFinishReason,
        warnings: resolvedWarnings ?? [],
      }),
      tokensIn: resolvedUsage?.inputTokens ?? null,
      tokensOut: resolvedUsage?.outputTokens ?? null,
      tokensReasoning:
        (resolvedUsage as any)?.outputTokenDetails?.reasoningTokens ??
        (resolvedSteps?.[resolvedSteps.length - 1]?.usage as any)
          ?.outputTokenDetails?.reasoningTokens ??
        null,
      durationMs: Date.now() - turnStart,
      model: resolvedResponse?.modelId ?? null,
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
    return rows.map((r: any) => ({
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
    }))
  }

  @callable()
  async getRecentTraceEvents(limit: number = 200): Promise<TraceEvent[]> {
    this.ensureDb()
    const rows = execSql(
      this,
      `SELECT * FROM trace_events ORDER BY id DESC LIMIT ?`,
      [limit],
    )
    return rows
      .map((r: any) => ({
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
      }))
      .reverse()
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
   *   run started / ended (with stop reason)
   *   job discovery returned new listings (tool_result of discover_jobs)
   *   cover letter drafted (tool_call of write_cover_letter)
   *   error during a run
   */
  @callable()
  async getRecentNotifications(limit: number = 12): Promise<
    Array<{
      id: number
      kind: "run" | "job" | "cover_letter" | "error" | "memory"
      title: string
      detail: string | null
      createdAt: string
    }>
  > {
    this.ensureDb()
    const n = Math.max(1, Math.min(limit, 50))
    // Pull the event types we care about, newest first.
    const rows = execSql(
      this,
      `SELECT id, run_id, step_number, event_type, label, payload,
              tokens_out, created_at
         FROM trace_events
        WHERE event_type IN ('run_start','run_end','tool_call','tool_result','error')
        ORDER BY id DESC
        LIMIT ?`,
      [n * 4], // over-fetch then filter down
    )

    type Note = {
      id: number
      kind: "run" | "job" | "cover_letter" | "error" | "memory"
      title: string
      detail: string | null
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

      if (et === "run_start") {
        notes.push({
          id,
          kind: "run",
          title: "Run started",
          detail: (r.run_id as string)?.slice(0, 14) ?? null,
          createdAt: when,
        })
      } else if (et === "run_end") {
        notes.push({
          id,
          kind: "run",
          title: "Run ended",
          detail: label ?? null,
          createdAt: when,
        })
      } else if (et === "error") {
        notes.push({
          id,
          kind: "error",
          title: "Run error",
          detail: payload ? payload.slice(0, 160) : null,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "discover_jobs") {
        notes.push({
          id,
          kind: "job",
          title: "Searched for jobs",
          detail: payload ? safePick(payload, "criteria") : null,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "write_cover_letter") {
        notes.push({
          id,
          kind: "cover_letter",
          title: "Drafted cover letter",
          detail: payload ?? null,
          createdAt: when,
        })
      } else if (et === "tool_call" && label === "remember") {
        notes.push({
          id,
          kind: "memory",
          title: "Agent saved a memory",
          detail: payload ? safePick(payload, "key") : null,
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
}

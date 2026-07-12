import { Agent, unstable_callable } from "agents"
import { generateText, streamText } from "ai"
import { getModel, getModelInfo, getParams } from "../llm"
// import type { TraceEntry } from "../utils/trace"
import obsConfig from "../observability-config.json"
import { DEFAULT_HARNESS_STATE } from "../types"
import type {
  Env,
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE INDEX IF NOT EXISTS idx_checkpoint_status
       ON run_checkpoints (status, updated_at DESC)`,
  )
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
  ): void {
    try {
      // Cap the messages JSON so a runaway buffer can't blow up the row.
      const messagesJson = JSON.stringify(messages).slice(0, 1024 * 1024)
      const planJson = plan ? JSON.stringify(plan) : null
      execSql(
        this,
        `INSERT INTO run_checkpoints (run_id, goal, step_number, messages_json, plan_json, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))
         ON CONFLICT(run_id) DO UPDATE SET
           step_number = excluded.step_number,
           messages_json = excluded.messages_json,
           plan_json = excluded.plan_json,
           status = 'running',
           updated_at = datetime('now')`,
        [runId, goal, stepNumber, messagesJson, planJson],
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
    updatedAt: string
  } | null {
    try {
      const rows = execSql(
        this,
        `SELECT run_id, goal, step_number, messages_json, plan_json, updated_at
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
      return {
        runId: r.run_id as string,
        goal: r.goal as string,
        stepNumber: r.step_number as number,
        messages,
        plan,
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

      // Load config overrides from SQLite into live state.
      // NOTE: only state-owned keys (goal, maxSteps, tokenBudget) are promoted
      // here; provider/model switching is intentionally NOT honored from
      // SQLite because the API key lives in env (different secret between
      // providers). Changing provider still requires a redeploy / secret swap.
      try {
        const rows = execSql(this, `SELECT key, value FROM config`)
        for (const row of rows) {
          if (row.key === "goal") {
            this.setState({ ...this.state, goal: row.value as string })
          } else if (row.key === "maxSteps") {
            this.setState({
              ...this.state,
              maxSteps: parseInt(row.value as string, 10) || 100,
            })
          } else if (row.key === "tokenBudget") {
            this.setState({
              ...this.state,
              tokenBudget: parseInt(row.value as string, 10) || 0,
            })
          }
        }
      } catch {
        // Config table may not have rows yet
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: start / pause / resume / stop / getStatus
  // ---------------------------------------------------------------------------

  @unstable_callable()
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

    // ANTI-PATTERN NOTE: awaiting the loop here blocks this RPC for the
    // entire multi-minute run. Durable Objects serialize their request
    // queue, so while runLoopWrapped is in-flight, /api/status and every
    // other harness RPC are queued behind it (you'll see 30s
    // blockConcurrencyWhile errors under load). Scheduling it via
    // this.schedule(0, ...) makes it WORSE — the scheduled task still runs
    // on the same DO and still blocks the queue, plus the alarm dispatcher
    // doesn't have a request lifecycle to attach to, so it can fatal-reset
    // the DO.
    //
    // The proper fix is to move the loop OFF the DO entirely — either by
    // delegating to a Cloudflare Workflow (each step is a Workflow step
    // with built-in retries, the DO only owns state), or by reshaping the
    // loop as one-iteration-per-alarm-tick (each alarm runs ONE LLM turn,
    // persists state, re-arms itself with schedule(0, …); requests can
    // interleave between ticks). Neither is a one-line fix; tracked as a
    // P1 architectural follow-up. For now we await so the loop at least
    // completes, knowing the UI will lag.
    try {
      await this.runLoopWrapped(runId, effectiveGoal)
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
        payload: `Run failed: ${error.message ?? String(error)} — checkpoint preserved for resume.`,
      })
      return `Run failed: ${error.message}`
    }

    return `Run ${runId} completed. Steps: ${this.state.currentStep}`
  }

  @unstable_callable()
  async pause(): Promise<string> {
    if (this.state.status === "running") {
      this.setState({ ...this.state, status: "paused" })
      return "Paused."
    }
    return `Cannot pause: status is "${this.state.status}"`
  }

  @unstable_callable()
  async resume(): Promise<string> {
    if (this.state.status === "paused") {
      this.setState({ ...this.state, status: "running" })
      return "Resumed."
    }
    return `Cannot resume: status is "${this.state.status}"`
  }

  @unstable_callable()
  async stop(): Promise<string> {
    this.setState({ ...this.state, status: "idle", currentStep: 0 })
    return "Stopped."
  }

  @unstable_callable()
  async getStatus(): Promise<HarnessState["status"]> {
    return this.state.status
  }

  @unstable_callable()
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
  @unstable_callable()
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

    try {
      await this.runLoopWrapped(runId, wakeGoal ?? this.state.goal)
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

    return { ran: true, reason: "completed" }
  }

  // Internal schedule check — same logic as the public checkSchedulesDue(),
  // but does NOT need the @unstable_callable wrapper because it is only ever
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
  async removeSchedule(id: number): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM schedules WHERE id = ?`, [id])
    return `Schedule ${id} removed.`
  }

  // NOTE: renamed from getSchedules() — that name is reserved by the base
  // Agent class (it returns its internal task schedules), so reusing it caused
  // a TS2416 incompatible-override error.
  @unstable_callable()
  async listSchedules(): Promise<ScheduleEntry[]> {
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

  @unstable_callable()
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

  @unstable_callable()
  async updateConfig(config: Record<string, string>): Promise<string> {
    this.ensureDb()

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
      }
    }

    return `Config updated: ${Object.keys(config).join(", ")}`
  }

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  // runLoopWrapped — the eviction-proof entry to runLoop.
  //
  // Durable Objects are evicted after ~70-140s of inactivity. A multi-step
  // autonomous run can take far longer than that, especially with
  // `reasoningEffort: "xhigh"` and tool calls that fan out to slow HTTP
  // endpoints. keepAliveWhile holds a reference-counted, alarm-backed
  // heartbeat for the duration of the run, guaranteeing the DO stays resident
  // until the loop finishes (whether by finish, budget, or error).
  //
  // This is the Cloudflare-recommended primitive for "multi-step tool
  // execution" (see schedule-tasks docs), and it composes with the SDK's own
  // alarm multiplexing — it will not fight our schedule()/scheduleEvery() use.
  //
  // TYPE NOTE: keepAliveWhile landed on the Agent base class AFTER 0.0.74
  // (this repo's pinned agents SDK version). It is therefore NOT on the
  // declared Agent<Env,State> type yet. The narrowing cast below is the
  // minimum needed to satisfy tsc against the current SDK; if you bump the
  // agents package, drop the cast and call this.keepAliveWhile(...) directly.
  private async runLoopWrapped(runId: string, goal: string): Promise<void> {
    const self = this as unknown as {
      keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>
    }
    if (typeof self.keepAliveWhile === "function") {
      await self.keepAliveWhile(() => this.runLoop(runId, goal))
    } else {
      // Defensive: older Agent base class lacks keepAliveWhile → fall back to
      // the raw loop. Logged so the operator notices the DO is unprotected.
      this.logStep(
        runId,
        0,
        "warn",
        null,
        "keepAliveWhile unavailable on base Agent; running unprotected",
      )
      await this.runLoop(runId, goal)
    }
  }

  private async runLoop(runId: string, goal: string): Promise<void> {
    const model = getModel(this.env)
    const maxSteps = this.state.maxSteps
    const tokenBudget = this.state.tokenBudget

    // ── Crash recovery: probe for a resumable checkpoint ────────────────
    // If THIS runId has a checkpoint with status='running', the previous
    // invocation was evicted / crashed mid-run. Resume it instead of starting
    // fresh — restore messages + plan, mark with a trace event so the
    // operator can see recovery happened.
    let resumedFromCheckpoint = false
    let resumedStepNumber = this.state.currentStep
    let resumedMessages: any[] | null = null
    let resumedPlan: Plan | null = null
    try {
      const rows = execSql(
        this,
        `SELECT step_number, messages_json, plan_json FROM run_checkpoints
          WHERE run_id = ? AND status = 'running'`,
        [runId],
      )
      if (rows.length > 0) {
        const r = rows[0] as any
        const parsed = JSON.parse(r.messages_json as string)
        if (Array.isArray(parsed) && parsed.length > 0) {
          resumedMessages = parsed
          resumedStepNumber = r.step_number as number
          try {
            if (r.plan_json) resumedPlan = JSON.parse(r.plan_json as string)
          } catch {
            // plan optional
          }
          resumedFromCheckpoint = true
        }
      }
    } catch {
      // checkpoints table may not exist yet — treat as no checkpoint
    }

    // ── Generate (or reuse) a structured plan ────────────────────────────
    // Per Cloudflare's long-running-agents doc, a plan persisted in state is
    // the canonical durability + orientation primitive: it lets a recovered
    // invocation know where it was, and "are we stuck?" reduces to "is
    // plan.currentStep advancing?". One extra LLM round trip at run start,
    // paid back many times over in context-efficiency across the run.
    //
    // We regenerate the plan every fresh run (runId changes) so the agent
    // starts each session with a plan that reflects the current pipeline
    // state + memory. The previous run's plan survives in trace_events for
    // audit; only the current plan lives in state. On a RESUMED run we reuse
    // the checkpointed plan without another round trip.
    let plan = resumedPlan ?? this.state.plan
    const planNeedsFresh =
      !resumedFromCheckpoint && (!plan || (plan as any)._runId !== runId)
    if (planNeedsFresh) {
      try {
        plan = await this.generatePlan(goal)
        // Stamp the plan with the run it belongs to so recovery logic can tell
        // whether a stored plan is for THIS run or a previous one.
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
        plan = null // plan generation is best-effort; loop still works without it
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

    // On a resumed run, reuse the checkpointed messages array so the model
    // picks up the conversation where it left off. Otherwise begin fresh.
    const messages: any[] = resumedMessages ?? [
      { role: "user", content: buildKickoffMessage(goal, runId) },
    ]

    if (resumedFromCheckpoint) {
      // Restore the step counter to where we were + emit a recovery trace
      // event so the dashboard can surface "this run was resumed after crash".
      this.setState({ ...this.state, currentStep: resumedStepNumber })
      this.pushTraceEvent({
        runId,
        stepNumber: resumedStepNumber,
        eventType: "run_start",
        label: "resumed",
        payload: JSON.stringify({
          reason: "checkpoint recovery",
          step: resumedStepNumber,
          messages: messages.length,
        }),
      })
    }

    // ---- Stuck-detection state ----
    // Instead of "called the same tool twice in a row = loop" (which kills
    // legitimate patterns like "discover_jobs on Monday then again on Tuesday"),
    // we track the last FEW tool calls and only flag repetition when:
    //   (a) the same tool is called with identical args N times in a row
    //       (default N=3), AND
    //   (b) the wall-clock between calls is short (likely an actual loop).
    // A search the operator wants to run twice in two different plan steps
    // will be separated by other tool calls (pipeline_status, remember, …) so
    // the consecutive-identical count resets naturally.
    let consecutiveIdenticalToolCalls = 0
    let lastToolName = ""
    let lastToolArgs = ""
    let lastToolCallAtMs = 0
    const IDENTICAL_TOOL_LIMIT = 3
    const IDENTICAL_TOOL_WINDOW_MS = 60_000 // <60s between identical calls = suspicious
    let consecutiveNoToolTurns = 0

    // ---- Context-retention policy ----
    // Tool results from `discover_jobs` carry large JSON payloads (5–10KB each).
    // Without pruning, the prompt grows ~5KB per search and gets re-sent every
    // turn — prompt token cost grows quadratically. We keep the most recent
    // tool results intact and REPLACE older tool_result content with a short
    // placeholder pointing the model at the tools it can use to re-fetch.
    const RETAIN_RECENT_TOOL_RESULTS = 4

    // ── Run bookkeeping for trace_events ───────────────────────────────────
    // Reset the monotonic seq counter + write a run_start and a system event
    // capturing the FULL composed prompt. Then snapshot the kickoff prompt
    // as one event so the dashboard can show "messages sent".
    this.traceSeq = 0
    this.pushTraceEvent({
      runId,
      eventType: "run_start",
      payload: JSON.stringify({ goal, maxSteps, tokenBudget }),
    })
    this.pushTraceEvent({
      runId,
      eventType: "system",
      role: "system",
      payload: systemPrompt,
    })

    while (true) {
      // ---- Stop condition: exceeded step ceiling ----
      if (this.state.currentStep >= maxSteps) {
        await this.finishRunAuto(
          runId,
          goal,
          `Stopped after reaching maxSteps (${maxSteps}). The agent was still working; consider raising the limit or narrowing the goal.`,
          "max_steps_reached",
        )
        return
      }

      // ---- Stop condition: token budget exhausted ----
      if (tokenBudget > 0 && this.state.tokensUsed >= tokenBudget) {
        await this.finishRunAuto(
          runId,
          goal,
          `Stopped after token budget (${tokenBudget}) was spent. Spent ${this.state.tokensUsed}.`,
          "token_budget_reached",
        )
        return
      }

      // ---- Stop condition: external pause/stop ----
      if (this.state.status === "paused" || this.state.status === "idle") {
        await this.finishRunAuto(
          runId,
          goal,
          `Run interrupted by external ${this.state.status}() call.`,
          "interrupted",
        )
        return
      }

      // ---- Snapshot the prompt as a trace event for this turn ----
      this.pushTraceEvent({
        runId,
        stepNumber: this.state.currentStep,
        eventType: "prompt",
        role: "user",
        payload: JSON.stringify(messages).slice(0, 16000),
      })

      // ---- Reset per-step delta buffers before streaming ----
      this.reasoningBuf = ""
      this.textBuf = ""

      // ---- One LLM turn, STREAMED so the dashboard can see live progress ----
      // streamText fires onChunk for reasoning-delta / text-delta / tool-call /
      // tool-result. We map those into trace_events live. In AI SDK v4, the
      // streamText result's metadata (usage, response, finishReason, steps,
      // text) are PROMISES that resolve once the stream completes — we consume
      // the stream first, then await each.
      const turnStart = Date.now()
      const currentStepNumber = this.state.currentStep
      let result
      try {
        result = streamText({
          model,
          tools,
          system: systemPrompt,
          messages,
          maxSteps: 1,
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
        // Drain the stream so all chunks fire and metadata promises resolve.
        for await (const _ of result.fullStream) {
          // consumed via onChunk above; do nothing here
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
        throw err
      }

      // ---- Await the resolved metadata (Promises in v4) ----
      const resolvedText = await result.text
      const resolvedUsage = await result.usage
      const resolvedWarnings = await result.warnings
      const resolvedResponse = await result.response
      const resolvedFinishReason = await result.finishReason
      const resolvedSteps = await result.steps

      // ---- Flush captured reasoning/text deltas for this step ----
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

      // ---- step_end event: usage, duration, model, finishReason ----
      this.pushTraceEvent({
        runId,
        stepNumber: currentStepNumber,
        eventType: "step_end",
        label: resolvedFinishReason ?? null,
        payload: JSON.stringify({
          finishReason: resolvedFinishReason,
          warnings: resolvedWarnings ?? [],
        }),
        tokensIn: resolvedUsage?.promptTokens ?? null,
        tokensOut: resolvedUsage?.completionTokens ?? null,
        tokensReasoning:
          (resolvedUsage as any)?.reasoningTokens ??
          (resolvedSteps?.[resolvedSteps.length - 1]?.usage as any)
            ?.reasoningTokens ??
          null,
        durationMs: Date.now() - turnStart,
        model: resolvedResponse?.modelId ?? null,
      })

      // ---- Observe usage (drives token-budget stop condition) ----
      const used = resolvedUsage?.totalTokens ?? 0
      if (used > 0) {
        this.setState({
          ...this.state,
          tokensUsed: this.state.tokensUsed + used,
        })
      }

      // ---- Did the agent call finish() and end the run itself? ----
      if (this.state.status === "done") {
        return
      }

      // ---- Inspect what the model did this turn for guard purposes ----
      // Reconstruct a generateText-like result shape for summarizeStep() and
      // extractTrace() which expect { steps, text, usage, response }.
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

      // ---- Smarter stuck detection ----
      // Behavior we WANT to allow:
      //   • Model pauses to plan or reports progress in text before next tool
      //   • The same search runs daily ("discover_jobs(senior AI, remote)")
      //   • A → B → A is always fine
      // Behavior we want to BLOCK:
      //   • N identical tool calls back-to-back within a short wall-clock
      //     window (the model is genuinely looping with no new input).
      // We bump the no-tool-turns limit to 3 so the model can reason twice
      // between actions — it's a job agent, planning is part of the job.
      if (!toolName) {
        consecutiveNoToolTurns++
        if (consecutiveNoToolTurns >= 3) {
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
        consecutiveNoToolTurns = 0
      }

      if (toolName) {
        const now = Date.now()
        const argsMatch = toolName === lastToolName && toolArgs === lastToolArgs
        if (argsMatch) {
          // Same tool, same args. Only count toward the limit if the previous
          // call was recent (likely a tight loop). If a meaningful amount of
          // time has passed, treat this as a fresh, deliberate re-search.
          const elapsed = now - lastToolCallAtMs
          if (elapsed < IDENTICAL_TOOL_WINDOW_MS) {
            consecutiveIdenticalToolCalls++
          } else {
            // Stale: this is a legitimate re-run after a long pause (e.g. a
            // scheduled re-search). Reset the counter.
            consecutiveIdenticalToolCalls = 1
          }
          if (consecutiveIdenticalToolCalls >= IDENTICAL_TOOL_LIMIT) {
            await this.finishRunAuto(
              runId,
              goal,
              `Stopped: ${IDENTICAL_TOOL_LIMIT} identical calls to ${toolName} within ${IDENTICAL_TOOL_WINDOW_MS / 1000}s — likely a tight loop.`,
              "repeated_loop_detected",
            )
            return
          }
        } else {
          consecutiveIdenticalToolCalls = 0
        }
        lastToolName = toolName
        lastToolArgs = toolArgs
        lastToolCallAtMs = now
      }

      // ---- Record the turn in step_log too (back-compat with Log tab) ----
      // The full trace lives in trace_events; step_log remains the legacy log.
      const trace = extractTrace(resultLike, currentStepNumber)
      trace.durationMs = Date.now() - turnStart
      this.logStepTrace(runId, trace)

      // ---- Append the model's turn to the running conversation ----
      messages.push(...(resolvedResponse.messages as any[]))

      // ---- Selective retention: prune old tool_result content ----
      // Tool results from `discover_jobs` carry large JSON payloads (~5–10KB).
      // Without pruning, every turn re-sends the entire history back to the
      // model, so prompt-token cost grows quadratically. We keep the most
      // recent few tool results intact and REPLACE older ones with a short
      // placeholder that tells the model which tool to call to re-fetch.
      // The model has `pipeline_status` and `recall` for exactly this purpose.
      compactToolResults(messages, RETAIN_RECENT_TOOL_RESULTS)

      // ---- Advance step counter ----
      const nextStep = this.state.currentStep + 1
      this.setState({
        ...this.state,
        currentStep: nextStep,
      })

      // ---- Crash recovery checkpoint (P1b) ----
      // Persist the in-memory loop state after every turn so an eviction or
      // crash mid-run can be resumed from this exact point. Slips one INSERT
      // per turn — cheap relative to the LLM call that just finished.
      this.writeCheckpoint(runId, goal, nextStep, messages, plan)
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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

  @unstable_callable()
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
  @unstable_callable()
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
  @unstable_callable()
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
  @unstable_callable()
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

  @unstable_callable()
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
      const toolNames = Object.keys(
        buildAgentTools(this, this.env, "_plan-synth", goal),
      ).join(", ")

      const { text } = await generateText({
        model,
        system:
          "You are a planner for an autonomous job-search agent. Break the goal into 4-6 concrete, ordered steps the agent can execute using ONLY these available tools. " +
          "Each step must be actionable in one or two tool calls. Output STRICT JSON: " +
          '{"steps":[{"id":"step-1","description":"..."},{"id":"step-2","description":"..."}]}. ' +
          "No prose, no markdown fences.",
        prompt: `Goal: ${goal}\nAvailable tools: ${toolNames}\n\nReturn the JSON plan now.`,
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

  @unstable_callable()
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
  @unstable_callable()
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

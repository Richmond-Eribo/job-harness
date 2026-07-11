import { Agent, unstable_callable } from "agents"
import { generateText, streamText } from "ai"
import { getModel, getModelInfo, getParams } from "../llm"
// import type { TraceEntry } from "../utils/trace"
import obsConfig from "../observability-config.json"
import { DEFAULT_HARNESS_STATE } from "../types"
import type {
  Env,
  HarnessState,
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
        payload = payload.slice(0, ev.eventType === "reasoning" ? maxReasoning : maxText)
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
            payload: chunk.result != null
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
        this.logStep(runId, t.stepNumber, t.action, t.toolArgs || null, t.toolOutput)
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

    const runId = generateRunId()
    const runGoal = goal ?? this.state.goal

    this.setState({
      ...this.state,
      status: "running",
      currentStep: 0,
      tokensUsed: 0,
      runId,
      goal: runGoal,
      lastRunAt: new Date().toISOString(),
      lastError: null,
    })

    try {
      await this.runLoopWrapped(runId, runGoal)
    } catch (error: any) {
      this.setState({
        ...this.state,
        status: "error",
        lastError: error.message ?? String(error),
      })
      this.logStep(runId, this.state.currentStep, "error", null, error.message)
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
    const runId = generateRunId()
    this.setState({
      ...this.state,
      status: "running",
      currentStep: 0,
      tokensUsed: 0,
      runId,
      lastRunAt: new Date().toISOString(),
      lastError: null,
    })

    try {
      await this.runLoopWrapped(runId, this.state.goal)
    } catch (error: any) {
      this.setState({
        ...this.state,
        status: "error",
        lastError: error.message ?? String(error),
      })
      this.logStep(runId, this.state.currentStep, "error", null, error.message)
      return { ran: true, reason: "errored: " + (error.message ?? String(error)) }
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
      agent: r.agent,
      tokensUsed: r.tokens_used,
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

    const tools = buildAgentTools(this, this.env, runId, goal)
    const systemPrompt = buildSystemPrompt(
      this,
      runId,
      goal,
      maxSteps,
      tokenBudget,
    )

    const messages: any[] = [
      { role: "user", content: buildKickoffMessage(goal, runId) },
    ]

    let lastToolName = ""
    let lastToolArgs = ""
    let consecutiveNoToolTurns = 0

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

      if (!toolName) {
        consecutiveNoToolTurns++
        if (consecutiveNoToolTurns >= 2) {
          await this.finishRunAuto(
            runId,
            goal,
            "Stopped: the agent produced no tool calls for two turns in a row (idle/stuck). " +
              (resolvedText || ""),
            "idle_detected",
          )
          return
        }
      } else {
        consecutiveNoToolTurns = 0
      }

      const toolArgs = stepSummary.toolArgs
      if (toolName && toolName === lastToolName && toolArgs === lastToolArgs) {
        await this.finishRunAuto(
          runId,
          goal,
          `Stopped: detected a repeated tool call (${toolName} with identical args) — likely stuck loop.`,
          "repeated_loop_detected",
        )
        return
      }
      lastToolName = toolName
      lastToolArgs = toolArgs

      // ---- Record the turn in step_log too (back-compat with Log tab) ----
      // The full trace lives in trace_events; step_log remains the legacy log.
      const trace = extractTrace(resultLike, currentStepNumber)
      trace.durationMs = Date.now() - turnStart
      this.logStepTrace(runId, trace)

      // ---- Append the model's turn to the running conversation ----
      messages.push(...(resolvedResponse.messages as any[]))

      // ---- Advance step counter ----
      this.setState({
        ...this.state,
        currentStep: this.state.currentStep + 1,
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
  async getRecentTraceEvents(
    limit: number = 200,
  ): Promise<TraceEvent[]> {
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

  /**
   * Auto-synthesize a goal when none exists. One non-tool generateText call
   * that looks at the available tool names + today's date and writes a single
   * concrete goal. Cheaper than a full loop; only runs when no goal is set.
   */
  async synthesizeGoalFromCapabilities(): Promise<string | null> {
    try {
      const model = getModel(this.env)
      const toolNames = Object.keys(buildAgentTools(this, this.env, "_goal-synth", "")).join(
        ", ",
      )
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

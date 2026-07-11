import { Agent, unstable_callable } from "agents"
import { generateText } from "ai"
import { getModel, getModelInfo, getParams } from "../llm"
import { DEFAULT_HARNESS_STATE } from "../types"
import type {
  Env,
  HarnessState,
  StepLogEntry,
  DailySummary,
  ScheduleEntry,
} from "../types"
import { execSql } from "../db/db"
import type { SqlAgent } from "../db/db"
import {
  validateCron,
  previousFire,
  nextFire,
  describeCron,
} from "../utils/cron"
import { generateRunId, summarizeStep } from "../utils/run"
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

      // ---- One LLM turn (single step so the loop stays visible) ----
      let result
      try {
        result = await generateText({
          model,
          tools,
          system: systemPrompt,
          messages,
          maxSteps: 1,
          ...getParams(this.env),
        })
      } catch (err: any) {
        this.logStep(
          runId,
          this.state.currentStep,
          "llm_error",
          null,
          err?.message ?? String(err),
        )
        throw err
      }

      // ---- Observe usage (drives token-budget stop condition) ----
      const used = result.usage?.totalTokens ?? 0
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
      const stepSummary = summarizeStep(result)
      const toolName = stepSummary.toolName

      if (!toolName) {
        consecutiveNoToolTurns++
        if (consecutiveNoToolTurns >= 2) {
          await this.finishRunAuto(
            runId,
            goal,
            "Stopped: the agent produced no tool calls for two turns in a row (idle/stuck). " +
              (result.text || ""),
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

      // ---- Record the turn (and its environmental feedback) in the log ----
      this.logStep(
        runId,
        this.state.currentStep,
        toolName ?? "think",
        toolArgs || null,
        stepSummary.toolOutput ?? result.text?.slice(0, 2000) ?? null,
      )

      // ---- Append the model's turn to the running conversation ----
      messages.push(...(result.response.messages as any[]))

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
    this.finishRunPersisted(runId, goal, reason, [code], code)
  }
}

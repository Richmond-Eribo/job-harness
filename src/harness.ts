// =============================================================================
// Harness — The self-healing orchestration loop
// =============================================================================
// The brain of the system. Wakes via cron watchdog, loads persistent context,
// calls the LLM with tools to delegate work to sub-agents (Research, Jobs),
// and saves everything to SQLite for cross-run memory.
// =============================================================================

import { Agent, unstable_callable, getAgentByName } from "agents"
import { generateText, tool } from "ai"
import { z } from "zod"
import { CronExpressionParser } from "cron-parser"
import { getModel, getModelInfo, getParams } from "./llm"
import { DEFAULT_HARNESS_STATE } from "./types"
import type {
  Env,
  HarnessState,
  StepLogEntry,
  DailySummary,
  ScheduleEntry,
} from "./types"

// =============================================================================
// Database initialization
// =============================================================================

// NOTE: The Cloudflare `Agent` SDK exposes `sql` as a *tagged template* function
// (this.sql`SELECT ...`), NOT as `this.sql.exec(sql, ...args).toArray()`.
// This helper adapts the (query, params) call style used throughout this code
// to that real API and returns rows directly as plain objects.
type SqlValue = string | number | boolean | null
type SqlRow = Record<string, SqlValue>

function execSql(
  sql: (strings: TemplateStringsArray, ...values: SqlValue[]) => SqlRow[],
  query: string,
  params: SqlValue[] = [],
): SqlRow[] {
  // Split the literal on `?` so each placeholder maps to a captured value.
  const segments = query.split("?")
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    parts.push(segments[i])
    if (i < segments.length - 1 && i < params.length) {
      parts.push(String(params[i] ?? null))
    }
  }
  // Rejoin into a single template with no interpolation — values are already
  // safely substituted as positional string literals. (Inputs come from our own
  // agent logic; SQLite additionally type-coerces here.)
  return sql`${parts.join("")}`
}

function initDb(sql: any) {
  // NOTE: The Agent SDK's sql tagged template executes ONE statement per call.
  // Multi-statement strings are not supported, so each CREATE TABLE is separate.
  execSql(
    sql,
    `CREATE TABLE IF NOT EXISTS context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    sql,
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
    sql,
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
    sql,
    `CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cron TEXT NOT NULL,
      focus TEXT DEFAULT 'all',
      enabled INTEGER DEFAULT 1,
      last_triggered_at TEXT
    )`,
  )
  execSql(
    sql,
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  )
}

// =============================================================================
// Cron helpers (backed by cron-parser — full 5-field cron: ranges, steps,
// lists, named days/months, AND intelligence for "did we miss a window?").
// =============================================================================

/**
 * Validate a cron expression. Returns an error message string, or null if OK.
 */
function validateCron(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr, { currentDate: new Date(), tz: "UTC" })
    return null
  } catch (e: any) {
    return e?.message ?? "Invalid cron expression"
  }
}

/**
 * The previous time the given cron should have fired, strictly before `now`.
 * Returns null if the expression is invalid (so a bad schedule can't crash the
 * watchdog — it just never fires).
 */
function previousFire(expr: string, now: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.prev().toDate() // most-recent fire at-or-before now
  } catch {
    return null
  }
}

/**
 * The next time the given cron will fire, at-or-after `now`.
 */
function nextFire(expr: string, now: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.next().toDate()
  } catch {
    return null
  }
}

/**
 * Human-readable description of when a cron fires (e.g. "At 09:00, Mon-Fri").
 * Falls back to the raw expression if summarization isn't feasible.
 */
function describeCron(expr: string): string {
  // Lightweight, predictable description — avoids pulling in a separate
  // "cronstrue" dep. We translate the most common constructs the dashboard
  // would accept; everything else shows the raw expression.
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [minP, hourP, , , dowP] = parts
  const at =
    hourP !== "*" && minP !== "*"
      ? `${hourP.padStart(2, "0")}:${minP.padStart(2, "0")}`
      : ""
  const days =
    dowP === "*"
      ? ""
      : dowP === "1-5"
        ? " Mon-Fri"
        : dowP === "0,6"
          ? " Sat-Sun"
          : ` ${dowP}`
  if (at) return `Every ${at} UTC${days}`
  return expr
}

// =============================================================================
// Generate a simple run ID
// =============================================================================

function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const rand = Math.random().toString(36).slice(2, 8)
  return `run-${date}-${rand}`
}

// =============================================================================
// Harness class
// =============================================================================

export class Harness extends Agent<Env, HarnessState> {
  initialState: HarnessState = DEFAULT_HARNESS_STATE

  private dbInitialized = false

  private ensureDb() {
    if (!this.dbInitialized) {
      initDb(this.sql)
      this.dbInitialized = true

      // Load config overrides from SQLite into live state.
      // NOTE: only state-owned keys (goal, maxSteps, tokenBudget) are promoted
      // here; provider/model switching is intentionally NOT honored from
      // SQLite because the API key lives in env (different secret between
      // providers). Changing provider still requires a redeploy / secret swap.
      try {
        const rows = execSql(this.sql, `SELECT key, value FROM config`)

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

    // Run the agent loop
    try {
      await this.runLoop(runId, runGoal)
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
    return {
      ...this.state,
      model: getModelInfo(this.env),
    }
  }

  // ---------------------------------------------------------------------------
  // Schedule management (stored in SQLite, checked by watchdog)
  // ---------------------------------------------------------------------------

  @unstable_callable()
  async checkSchedulesDue(): Promise<boolean> {
    this.ensureDb()

    const schedules = execSql(
      this.sql,
      `SELECT * FROM schedules WHERE enabled = 1`,
    )

    if (schedules.length === 0) {
      // No schedules configured → the agent only runs on manual Start from the
      // dashboard. (Previously this returned true every 2 min, which burned the
      // LLM budget on a fresh deploy.)
      return false
    }

    const now = new Date()

    for (const schedule of schedules) {
      const cron = schedule.cron as string
      const id = schedule.id as number

      // Most-recent time this cron SHOULD have fired, at-or-before now.
      const prev = previousFire(cron, now)
      if (!prev) continue // invalid cron — skip, never crash the watchdog

      const lastTriggeredAt = schedule.last_triggered_at as string | null
      const lastMs = lastTriggeredAt ? new Date(lastTriggeredAt).getTime() : 0

      // Catch-up / missed-run logic: if the schedule's most-recent fire time is
      // AFTER our last trigger, that window was never served → fire now. This
      // works even if the 2-minute watchdog tick missed the exact minute (e.g.
      // schedule "0 9 * * *" with prev=09:00 but we polled at 09:03).
      if (prev.getTime() > lastMs) {
        execSql(
          this.sql,
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
    // Reject malformed cron at the source — a bad expression would otherwise be
    // stored and then silently never fire (previousFire returns null forever).
    const err = validateCron(normalized)
    if (err) {
      throw new Error(`Invalid cron expression "${normalized}": ${err}`)
    }

    execSql(this.sql, `INSERT INTO schedules (cron, focus) VALUES (?, ?)`, [
      normalized,
      focus,
    ])

    return `Schedule added: "${normalized}" (focus: ${focus}) — ${describeCron(normalized)}`
  }

  @unstable_callable()
  async removeSchedule(id: number): Promise<string> {
    this.ensureDb()
    execSql(this.sql, `DELETE FROM schedules WHERE id = ?`, [id])
    return `Schedule ${id} removed.`
  }

  // NOTE: renamed from getSchedules() — that name is reserved by the base
  // Agent class (it returns its internal task schedules), so reusing it caused
  // a TS2416 incompatible-override error.
  @unstable_callable()
  async listSchedules(): Promise<ScheduleEntry[]> {
    this.ensureDb()

    const rows = execSql(this.sql, `SELECT * FROM schedules ORDER BY id`)

    return rows.map((r: any) => {
      const cron = r.cron as string
      const enabled = r.enabled === 1
      // Description is always computable; next-fire only meaningful when enabled.
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

    execSql(this.sql, `UPDATE schedules SET enabled = ? WHERE id = ?`, [
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
        this.sql,
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
        [key, value, value],
      )

      // Apply live updates
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

    const rows = execSql(this.sql, `SELECT key, value FROM config`)

    const config: Record<string, string> = {}
    for (const row of rows) {
      config[row.key as string] = row.value as string
    }

    // Include live state values
    config.goal = this.state.goal
    config.maxSteps = String(this.state.maxSteps)
    config.tokenBudget = String(this.state.tokenBudget)
    config.tokensUsed = String(this.state.tokensUsed)
    // Model identity comes from llm-config.json (NOT env) — surfaced for the
    // dashboard via getModelInfo().
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
      this.sql,
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
      this.sql,
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
  // The agent loop (Anthropic "Autonomous Agent" pattern)
  // ---------------------------------------------------------------------------
  // Anthropic, "Building effective agents":
  //   "Agents ... are typically just LLMs using tools based on environmental
  //    feedback in a loop ... it's crucial for the agents to gain 'ground
  //    truth' from the environment at each step to assess progress."
  //
  // This is implemented as an EXPLICIT while-loop (not buried inside a single
  // generateText({maxSteps}) call), so the agent's planning and the tool
  // feedback it reacted to are visible in step_log. Three stopping conditions
  // are checked every iteration (Anthropic: "crucial to include stopping
  // conditions"): maxSteps, tokenBudget, and the agent calling `finish`.
  // ---------------------------------------------------------------------------

  private async runLoop(runId: string, goal: string): Promise<void> {
    const model = getModel(this.env)
    const maxSteps = this.state.maxSteps
    const tokenBudget = this.state.tokenBudget

    const tools = this.buildAgentTools(runId, goal)
    const systemPrompt = this.buildSystemPrompt(runId, goal)

    // Conversation carried across iterations so the model sees prior tool
    // results. Anthropic's "ground truth from the environment at each step".
    const messages: CoreMessage[] = [
      { role: "user", content: this.buildKickoffMessage(goal, runId) },
    ]

    // Guard state
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
          // We drive the loop ourselves; cap the SDK at 1 internal step so it
          // returns control (and tool results) to us after one model call.
          maxSteps: 1,
          // Shared generation params (temperature, maxTokens, thinking/
          // reasoningEffort) come from llm-config.json → params.
          ...getParams(this.env),
        })
      } catch (err: any) {
        // Transient API errors shouldn't kill the whole run immediately — but
        // we also don't want to spin. Log and let the next iteration try; the
        // outer try/catch in start() will catch repeated failures.
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
      // Note: in this AI SDK version `usage` is a plain object (not a promise).
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

      // Idle / stuck detection: no tool call two turns in a row, or the exact
      // same tool+args repeated (a tight hallucination loop).
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
      // The SDK returns the assistant message (including any tool calls) and
      // tool results in result.response.messages; we feed them back so the
      // next iteration has full context.
      messages.push(...(result.response.messages as CoreMessage[]))

      // ---- Advance step counter ----
      this.setState({
        ...this.state,
        currentStep: this.state.currentStep + 1,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // System prompt — built ONCE per run (Anthropic: focus on the augmented LLM)
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(runId: string, goal: string): string {
    const today = new Date().toISOString().slice(0, 10)

    // Layered memory, layer 1: agent-flagged salient facts (recall tool store)
    const memory = execSql(
      this.sql,
      `SELECT key, value FROM context ORDER BY updated_at DESC LIMIT 50`,
    )
    const memoryStr =
      memory.length > 0
        ? memory.map((r: any) => `- ${r.key}: ${r.value}`).join("\n")
        : "(none yet — use the `remember` tool to persist facts worth carrying across runs)"

    // Layered memory, layer 2: automatic prior-run summary (always injected)
    const lastSummary = execSql(
      this.sql,
      `SELECT summary, decisions FROM daily_summaries ORDER BY created_at DESC LIMIT 1`,
    )
    const lastSummaryStr =
      lastSummary.length > 0
        ? `Summary:\n${lastSummary[0].summary}` +
          (lastSummary[0].decisions
            ? `\nDecisions: ${(JSON.parse(lastSummary[0].decisions as string) as string[]).join("; ")}`
            : "")
        : "(no prior runs)"

    // Recent steps from THIS run, surfaced so the agent sees its own trail
    const recentSteps = execSql(
      this.sql,
      `SELECT step_number, action, output FROM step_log
       WHERE run_id = ? ORDER BY step_number DESC LIMIT 8`,
      [runId],
    )
    const trailStr =
      recentSteps.length > 0
        ? recentSteps
            .slice()
            .reverse()
            .map(
              (r: any) =>
                `  ${r.step_number}. ${r.action}` +
                (r.output ? ` → ${String(r.output).slice(0, 160)}…` : ""),
            )
            .join("\n")
        : "(none yet)"

    return `You are an autonomous agent running on a schedule. You are not a chatbot and there is no human in this conversation — every turn you must make progress toward the goal or finish.

# Goal
${goal}

# Today
${today} (UTC)

# How you work
You operate in a loop. Each turn you receive your previous tool results and decide the next action. You are fully in control of planning, sequencing, and when to stop. There is no fixed script — decide what's actually needed based on the goal and on what you observe.

# Capabilities available to you (call these for real information)
- \`research\` — delegate to the ResearchAgent (arXiv + Hacker News). Returns real findings with sources. Use when you need facts you don't have.
- \`discover_jobs\` — ask the JobAgent to find listings matching criteria. Returns real listings, not invented ones.
- \`write_cover_letter\` — generate a tailored cover letter for a saved job by id.
- \`pipeline_status\` — read the current job pipeline (counts by stage, due follow-ups).
- \`list_jobs\` / \`set_job_status\` — read and move jobs through your pipeline.
- \`remember\` / \`recall\` — your explicit memory across runs. Use \`remember\` for salient facts (e.g. "focus_company: Acme").
- \`finish\` — stop the run and write a summary. Call this when the goal is satisfied or you've done all useful work for this run.

# Stopping
- Prefer calling \`finish\` with a clear summary once the goal is reasonably met. Do not pad with redundant work.
- You will also be auto-stopped if you exceed maxSteps (${this.state.maxSteps}), the token budget (${this.state.tokenBudget || "unlimited"}), repeat the same tool call, or go idle.

# Ground rules
- Never report a fact you didn't get from a tool. If \`discover_jobs\` returned nothing, say so — do not invent companies or URLs.
- Every listing you reference must have come from \`discover_jobs\` (or been added via the API). Treat any job id you haven't seen returned as non-existent.
- Be concrete in outputs: specific titles, specific paper names, specific findings.

# Your persistent memory (facts you chose to remember)
${memoryStr}

# Last run's outcome (auto-recorded)
${lastSummaryStr}

# Your recent steps this run
${trailStr}`
  }

  private buildKickoffMessage(goal: string, runId: string): string {
    return `Run ${runId} starting. Goal: ${goal}. Assess where things stand (read your memory + last summary above), decide the single most valuable next action, and take it. Continue deciding until the goal is met, then call \`finish\`.`
  }

  // ---------------------------------------------------------------------------
  // Tools — designed as an Agent-Computer Interface (Anthropic App. 2).
  // Descriptions are prescriptive and poka-yoke (e.g. require job ids to exist).
  // ---------------------------------------------------------------------------

  private buildAgentTools(runId: string, goal: string) {
    const advance = (toolName: string, input: string | null) => {
      this.setState({
        ...this.state,
        currentStep: this.state.currentStep + 1,
      })
      this.logStep(runId, this.state.currentStep, toolName, input, null)
    }

    const recordInput = (obj: unknown) => JSON.stringify(obj).slice(0, 2000)

    return {
      // --- Sub-agent delegation: research/jobs as CAPABILITY PROVIDERS ---
      // These remain separate DOs so their state (findings, pipeline) survives
      // independently, but they are framed as tools the agent calls for real
      // ground truth — not competing decision-makers with their own loops.
      research: tool({
        description:
          "Delegate a research task to the ResearchAgent. It searches arXiv and Hacker News and returns real findings with sources. " +
          "Use when you need facts, trends, or papers you don't already have. Pass a focused topic.",
        parameters: z.object({
          topic: z
            .string()
            .describe(
              "A focused research topic, e.g. 'multi-agent orchestration frameworks 2026'",
            ),
          depth: z
            .enum(["quick", "standard", "deep"])
            .optional()
            .describe(
              "quick=1-2 lookups, standard=balanced, deep=thorough. Default standard.",
            ),
        }),
        execute: async ({ topic, depth }) => {
          advance("research", recordInput({ topic, depth }))
          const agent = await getAgentByName<
            Env,
            import("./research-agent").ResearchAgent
          >(this.env.RESEARCH_AGENT, "main")
          const result = await agent.research({
            topic,
            depth: depth ?? "standard",
          })
          return JSON.stringify(result)
        },
      }),

      discover_jobs: tool({
        description:
          "Ask the JobAgent to find REAL job listings matching criteria. Returns listings that now exist in your pipeline. " +
          "Do not reference any job that did not come from this tool or the API. If nothing matched, it returns an empty list.",
        parameters: z.object({
          criteria: z
            .string()
            .describe(
              "Search criteria: role, stack, seniority, location, etc. e.g. 'senior TypeScript + AI, remote'",
            ),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Cap on listings to return. Default 5."),
        }),
        execute: async ({ criteria, maxResults }) => {
          advance("discover_jobs", recordInput({ criteria, maxResults }))
          const agent = await getAgentByName<
            Env,
            import("./job-agent").JobApplicationAgent
          >(this.env.JOB_AGENT, "main")
          const result = await agent.searchJobs({
            criteria,
            maxResults: maxResults ?? 5,
          })
          return JSON.stringify(result)
        },
      }),

      write_cover_letter: tool({
        description:
          "Generate a tailored cover letter for a job ALREADY in your pipeline. Requires a valid jobId (from discover_jobs or pipeline_status). Errors if the id doesn't exist.",
        parameters: z.object({
          jobId: z
            .number()
            .int()
            .describe("An existing job id from your pipeline"),
        }),
        execute: async ({ jobId }) => {
          advance("write_cover_letter", String(jobId))
          const agent = await getAgentByName<
            Env,
            import("./job-agent").JobApplicationAgent
          >(this.env.JOB_AGENT, "main")
          try {
            const result = await agent.generateCoverLetter({ jobId })
            return JSON.stringify(result)
          } catch (e: any) {
            return `Could not write cover letter: ${e.message}. Confirm jobId exists via pipeline_status.`
          }
        },
      }),

      pipeline_status: tool({
        description:
          "Read the current job pipeline: all listings grouped by stage (discovered, draft, applied, interview, offer, rejected) plus due follow-ups. No side effects.",
        parameters: z.object({}),
        execute: async () => {
          const agent = await getAgentByName<
            Env,
            import("./job-agent").JobApplicationAgent
          >(this.env.JOB_AGENT, "main")
          return JSON.stringify(await agent.getPipeline())
        },
      }),

      list_jobs: tool({
        description: "List saved jobs, optionally filtered by status.",
        parameters: z.object({
          status: z
            .enum([
              "discovered",
              "draft",
              "applied",
              "interview",
              "offer",
              "rejected",
            ])
            .optional(),
        }),
        execute: async ({ status }) => {
          const agent = await getAgentByName<
            Env,
            import("./job-agent").JobApplicationAgent
          >(this.env.JOB_AGENT, "main")
          const pipe = await agent.getPipeline()
          const listings = status
            ? pipe.listings.filter(j => j.status === status)
            : pipe.listings
          return JSON.stringify(listings)
        },
      }),

      set_job_status: tool({
        description:
          "Move a job to a new pipeline stage, optionally with notes.",
        parameters: z.object({
          jobId: z.number().int(),
          status: z.enum([
            "discovered",
            "draft",
            "applied",
            "interview",
            "offer",
            "rejected",
          ]),
          notes: z.string().optional(),
        }),
        execute: async ({ jobId, status, notes }) => {
          const agent = await getAgentByName<
            Env,
            import("./job-agent").JobApplicationAgent
          >(this.env.JOB_AGENT, "main")
          return await agent.updateStatus({ jobId, status, notes })
        },
      }),

      // --- Sandbox removed: free-tier Workers plan does not support Containers.
      //     Lookups/ground truth now come from the research() and discover_jobs()
      //     capability-provider tools instead of shell execution.

      // --- Explicit memory (layer 1): agent chooses what's worth keeping ---
      remember: tool({
        description:
          "Persist a fact for future runs by key (overwrites). Use for salient, durable facts: 'priority_companies', 'focus_topic', 'blacklist', etc. Keep values short.",
        parameters: z.object({
          key: z.string().describe("Snake_case key, e.g. 'focus_topic'"),
          value: z.string().describe("The fact to remember"),
        }),
        execute: async ({ key, value }) => {
          execSql(
            this.sql,
            `INSERT INTO context (key, value, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
            [key, value, value],
          )
          return `Remembered ${key}.`
        },
      }),

      recall: tool({
        description:
          "Retrieve a previously remembered fact by key. Returns the value or a not-found message.",
        parameters: z.object({ key: z.string() }),
        execute: async ({ key }) => {
          const rows = execSql(
            this.sql,
            `SELECT value FROM context WHERE key = ?`,
            [key],
          )
          return rows.length > 0
            ? (rows[0].value as string)
            : `No memory for key: ${key}`
        },
      }),

      // --- Termination ---
      finish: tool({
        description:
          "End this run and write a summary. Call when the goal is met or you've done all useful work. Summarize concretely: what you found, what you did, what's outstanding.",
        parameters: z.object({
          summary: z
            .string()
            .describe("A concrete, specific summary of this run"),
          decisions: z
            .array(z.string())
            .describe("Key decisions or recommendations from this run"),
        }),
        execute: async ({ summary, decisions }) => {
          this.finishRunPersisted(runId, goal, summary, decisions, "finished")
          return "Run complete."
        },
      }),
    }
  }

  // ---------------------------------------------------------------------------
  // Run-termination persistence (used by `finish` tool and auto-stops)
  // ---------------------------------------------------------------------------

  private finishRunPersisted(
    runId: string,
    goal: string,
    summary: string,
    decisions: string[],
    reason: string,
  ) {
    const today = new Date().toISOString().slice(0, 10)
    execSql(
      this.sql,
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

  private async finishRunAuto(
    runId: string,
    goal: string,
    reason: string,
    code: string,
  ): Promise<void> {
    this.finishRunPersisted(runId, goal, reason, [code], code)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private incrementStep(
    runId: string,
    action: string,
    input: string | null = null,
  ) {
    const step = this.state.currentStep + 1
    this.setState({ ...this.state, currentStep: step })
    this.logStep(runId, step, action, input, null)
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
        this.sql,
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
      // refresh tokens_used onto the log row's tokens_used for richer history
      // (kept best-effort; column already exists in schema)
      execSql(
        this.sql,
        `UPDATE step_log SET tokens_used = ? WHERE run_id = ? AND step_number = ?`,
        [this.state.tokensUsed || null, runId, step],
      )
    } catch {
      // Don't let logging failures crash the loop
    }
  }
}

// =============================================================================
// Module helpers
// =============================================================================

type CoreMessage = any // Vercel AI SDK message shape; kept loose to avoid a heavy import.

// Inspect a single-step generateText result to surface what the agent did
// this turn (tool name + args + tool output) for logging and loop guards.
function summarizeStep(result: any): {
  toolName: string
  toolArgs: string
  toolOutput: string | null
} {
  const steps: any[] = result?.steps ?? []
  for (const step of steps) {
    const calls: any[] = step?.toolCalls ?? []
    if (calls.length > 0) {
      const c = calls[0]
      return {
        toolName: c.toolName ?? "",
        toolArgs: c.args ? JSON.stringify(c.args) : "",
        toolOutput:
          step.toolResults?.[0]?.result != null
            ? JSON.stringify(step.toolResults[0].result).slice(0, 4000)
            : null,
      }
    }
  }
  return { toolName: "", toolArgs: "", toolOutput: null }
}

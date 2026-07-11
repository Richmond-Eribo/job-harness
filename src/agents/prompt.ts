import type { SqlAgent } from "../db/db"
import { execSql } from "../db/db"
import { SOUL_MD, DEFAULT_MD } from "./prompt-loader"

// =============================================================================
// FOUR-LAYER SYSTEM PROMPT
// =============================================================================
//   1. soul.md        — identity + values (static)
//   2. default.md     — capabilities + ground rules (static baseline)
//   3. user_memory    — human-authored notes (dashboard-editable)
//   4. live context   — goal, today, agent memory, last-run trace, this-run trail
//
// Each layer is editable/clearly separable. The composed string is also written
// to trace_events (event_type='system') at run start so the dashboard can show
// the exact prompt the model received.
// =============================================================================

function readUserMemory(agent: SqlAgent): string {
  try {
    const rows = execSql(
      agent,
      `SELECT key, value FROM user_memory ORDER BY key ASC LIMIT 50`,
    )
    if (rows.length === 0)
      return "(no user-authored notes yet — add them from the dashboard Memory tab)"
    return rows.map((r: any) => `- ${r.key}: ${r.value}`).join("\n")
  } catch {
    // table may not exist on first run before migration
    return "(user memory unavailable)"
  }
}

function readAgentMemory(agent: SqlAgent): string {
  const memory = execSql(
    agent,
    `SELECT key, value FROM context ORDER BY updated_at DESC LIMIT 50`,
  )
  return memory.length > 0
    ? memory.map((r: any) => `- ${r.key}: ${r.value}`).join("\n")
    : "(none yet — use the `remember` tool to persist facts worth carrying across runs)"
}

/** Read the prior run's trace events back as a short "what you tried" block. */
function readLastRunTrace(agent: SqlAgent): string {
  try {
    const lastRun = execSql(
      agent,
      `SELECT run_id FROM trace_events WHERE event_type = 'run_start'
       ORDER BY created_at DESC LIMIT 1`,
    )
    if (lastRun.length === 0) return "(no prior runs)"
    const priorRunId = lastRun[0].run_id as string
    // exclude this run by selecting only events older than the latest run_start
    const events = execSql(
      agent,
      `SELECT event_type, label, payload, tokens_out FROM trace_events
       WHERE run_id = ? AND event_type IN ('tool_call','text','run_end','error')
       ORDER BY seq ASC LIMIT 40`,
      [priorRunId],
    )
    if (events.length === 0) return `(run ${priorRunId} — no events)`
    const lines: string[] = []
    for (const ev of events) {
      const t = ev.event_type as string
      const label = ev.label as string | null
      if (t === "tool_call") {
        lines.push(`  • called ${label ?? "tool"}`)
      } else if (t === "text") {
        const p = ev.payload ? String(ev.payload).slice(0, 100) : ""
        lines.push(`  • text: ${p}${p.length >= 100 ? "…" : ""}`)
      } else if (t === "run_end") {
        const p = ev.payload ? String(ev.payload).slice(0, 200) : ""
        lines.push(`  • ended: ${p}`)
      } else if (t === "error") {
        lines.push(`  • ERROR: ${ev.payload ?? ""}`)
      }
    }
    return `Last run ${priorRunId}:\n${lines.join("\n")}`
  } catch {
    // trace_events may not exist yet
    return "(prior-run trace unavailable)"
  }
}

function readLastSummary(agent: SqlAgent): string {
  const lastSummary = execSql(
    agent,
    `SELECT summary, decisions FROM daily_summaries ORDER BY created_at DESC LIMIT 1`,
  )
  return lastSummary.length > 0
    ? `Summary:\n${lastSummary[0].summary}` +
        (lastSummary[0].decisions
          ? `\nDecisions: ${(JSON.parse(lastSummary[0].decisions as string) as string[]).join("; ")}`
          : "")
    : "(no prior runs)"
}

function readThisRunTrail(agent: SqlAgent, runId: string): string {
  // Prefer trace_events; fall back to step_log for runs started before the
  // trace_events migration existed.
  try {
    const events = execSql(
      agent,
      `SELECT seq, event_type, label, payload FROM trace_events
       WHERE run_id = ? AND event_type IN ('tool_call','text','tool_result','reasoning')
       ORDER BY seq DESC LIMIT 12`,
      [runId],
    )
    if (events.length > 0) {
      return events
        .slice()
        .reverse()
        .map((r: any) => {
          const t = r.event_type as string
          const label = r.label as string | null
          const p = r.payload ? String(r.payload).slice(0, 160) : ""
          return `  [${r.seq}] ${t}${label ? `:${label}` : ""}${p ? ` → ${p}${p.length >= 160 ? "…" : ""}` : ""}`
        })
        .join("\n")
    }
  } catch {
    // fallthrough
  }
  const recentSteps = execSql(
    agent,
    `SELECT step_number, action, output FROM step_log
     WHERE run_id = ? ORDER BY step_number DESC LIMIT 8`,
    [runId],
  )
  return recentSteps.length > 0
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
}

export function buildSystemPrompt(
  agent: SqlAgent,
  runId: string,
  goal: string,
  maxSteps: number,
  tokenBudget: number,
): string {
  const today = new Date().toISOString().slice(0, 10)

  return [
    // ── Layer 1: soul (identity + values) ────────────────────────────────
    SOUL_MD,
    "",
    // ── Layer 2: default (capabilities + ground rules) ───────────────────
    DEFAULT_MD,
    "",
    // ── Layer 3: user-authored memory (human-set, high authority) ────────
    "# Notes from the operator (you must respect these)",
    readUserMemory(agent),
    "",
    // ── Layer 4: live context ────────────────────────────────────────────
    "# Goal",
    goal,
    "",
    "# Today",
    `${today} (UTC)`,
    "",
    "# Budgets this run",
    `maxSteps: ${maxSteps} · token budget: ${tokenBudget || "unlimited"}`,
    "",
    "# Your persistent memory (facts you chose to remember)",
    readAgentMemory(agent),
    "",
    "# Last run's outcome (auto-recorded)",
    readLastSummary(agent),
    "",
    "# What you tried last run (from your trace)",
    readLastRunTrace(agent),
    "",
    "# Your steps so far this run",
    readThisRunTrail(agent, runId),
  ].join("\n")
}

export function buildKickoffMessage(goal: string, runId: string): string {
  return `Run ${runId} starting. Goal: ${goal}. Assess where things stand (read your memory + last summary + last-run trace above), decide the single most valuable next action, and take it. Continue deciding until the goal is met, then call \`finish\`.`
}

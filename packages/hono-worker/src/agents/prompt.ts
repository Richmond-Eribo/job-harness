import type { SqlAgent } from "../db/db"
import { execSql } from "../db/db"
import { SOUL_MD, DEFAULT_MD } from "./prompt-loader"

// =============================================================================
// FIVE-LAYER SYSTEM PROMPT
// =============================================================================
//   1. soul.md        — identity + values (static)
//   2. default.md     — capabilities + ground rules (static baseline)
//   3. candidate      — the user's profile + CV excerpt (per-user; every
//                       decision must be grounded in it)
//   4. user_memory    — human-authored notes (dashboard-editable)
//   5. live context   — goal, today, agent memory, last-run summary + trace
//
// Each layer is editable/clearly separable. The composed string is also written
// to trace_events (event_type='system') at run start so the dashboard can show
// the exact prompt the model received.
//
// STABILITY RULE: the prompt must NOT change from turn to turn within a run —
// every mutation defeats provider prompt caching (measured: cacheWrite 0
// across a 33-step run while input tokens grew 6k→26k). Turn-varying context
// belongs in the MESSAGES (the conversation itself), never here; mid-run
// history growth is handled by compaction (agents/compaction.ts), not by
// re-summarizing the trail into the system prompt.
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

/** Read the PRIOR run's trace events back as a short "what you tried" block. */
function readLastRunTrace(agent: SqlAgent, runId: string): string {
  try {
    // Latest run_start EXCLUDING the current run — mid-run, the newest
    // run_start belongs to the run in progress, so filtering by run_id (not
    // recency alone) is what makes this actually read the PRIOR run.
    const lastRun = execSql(
      agent,
      `SELECT run_id FROM trace_events
       WHERE event_type = 'run_start' AND parent_id IS NULL AND run_id != ?
       ORDER BY created_at DESC LIMIT 1`,
      [runId],
    )
    if (lastRun.length === 0) return "(no prior runs)"
    const priorRunId = lastRun[0].run_id as string
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

export function buildSystemPrompt(
  agent: SqlAgent,
  runId: string,
  goal: string,
  maxSteps: number,
  tokenBudget: number,
  plan: import("../types").Plan | null,
  profileSummary: string,
): string {
  const today = new Date().toISOString().slice(0, 10)

  // Render the plan into a compact block the model can orient on. The plan
  // is a durability + orientation primitive (Cloudflare "planning as a
  // durability strategy"): it tells a recovered invocation where it was
  // without having to replay every prior turn.
  const planBlock = plan
    ? [
        "# Your plan for this run",
        `Current step: ${plan.currentStep + 1} of ${plan.steps.length}`,
        "",
        ...plan.steps.map((s, i) => {
          const n = i + 1
          const marker =
            s.status === "complete"
              ? "[x]"
              : s.status === "in_progress"
                ? "[>]"
                : s.status === "failed"
                  ? "[!]"
                  : s.status === "skipped"
                    ? "[-]"
                    : "[ ]"
          return `${marker} ${n}. ${s.description}${
            s.result ? ` — ${String(s.result).slice(0, 200)}` : ""
          }`
        }),
        "",
        "Work through the steps in order. When a step is done, move on to the next. If a step becomes impossible, skip it and note why. The plan is yours to revise if you discover the goal needs a different breakdown.",
      ].join("\n")
    : "# Your plan for this run\n(No structured plan — work toward the goal directly.)"

  return [
    // ── Layer 1: soul (identity + values) ────────────────────────────────
    SOUL_MD,
    "",
    // ── Layer 2: default (capabilities + ground rules) ───────────────────
    DEFAULT_MD,
    "",
    // ── Layer 3: the candidate (per-user profile + CV excerpt) ───────────
    // The single highest-authority statement of WHO the agent works for.
    // Without it the model invents its own assumptions about roles, stack,
    // seniority, and location — the exact failure this layer exists to fix.
    "# The candidate you work for",
    "Every search criterion you write, match score you assign, and application decision you make MUST be grounded in this profile. Never assume a role, stack, seniority, or location the profile does not support.",
    profileSummary,
    "",
    // ── Layer 4: user-authored memory (human-set, high authority) ────────
    "# Notes from the operator (you must respect these)",
    readUserMemory(agent),
    "",
    // ── Layer 5: live context ────────────────────────────────────────────
    "# Goal",
    goal,
    "",
    planBlock,
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
    readLastRunTrace(agent, runId),
  ].join("\n")
}

export function buildKickoffMessage(goal: string, runId: string): string {
  return `Run ${runId} starting. Goal: ${goal}. Assess where things stand (read your memory + last summary + last-run trace above), decide the single most valuable next action, and take it. Continue deciding until the goal is met, then call \`finish\`.`
}

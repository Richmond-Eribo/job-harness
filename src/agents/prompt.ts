import type { SqlAgent } from "../db/db"
import { execSql } from "../db/db"

export function buildSystemPrompt(
  agent: SqlAgent,
  runId: string,
  goal: string,
  maxSteps: number,
  tokenBudget: number,
): string {
  const today = new Date().toISOString().slice(0, 10)

  // Layered memory, layer 1: agent-flagged salient facts (recall tool store)
  const memory = execSql(
    agent,
    `SELECT key, value FROM context ORDER BY updated_at DESC LIMIT 50`,
  )
  const memoryStr =
    memory.length > 0
      ? memory.map((r: any) => `- ${r.key}: ${r.value}`).join("\n")
      : "(none yet — use the `remember` tool to persist facts worth carrying across runs)"

  // Layered memory, layer 2: automatic prior-run summary (always injected)
  const lastSummary = execSql(
    agent,
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
    agent,
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
- You will also be auto-stopped if you exceed maxSteps (${maxSteps}), the token budget (${tokenBudget || "unlimited"}), repeat the same tool call, or go idle.

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

export function buildKickoffMessage(goal: string, runId: string): string {
  return `Run ${runId} starting. Goal: ${goal}. Assess where things stand (read your memory + last summary above), decide the single most valuable next action, and take it. Continue deciding until the goal is met, then call \`finish\`.`
}

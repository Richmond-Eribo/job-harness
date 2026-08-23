// =============================================================================
// Compaction — the mid-run context guardrail (layer 2 of 3).
// =============================================================================
// THE LADDER (outermost first):
//   1. Tool-result clearing  — compactToolResults() in harness.ts replaces old
//      tool outputs with re-fetch placeholders (adaptive retention window).
//      Lightest touch; Anthropic ships this as API-side "context editing".
//   2. THIS MODULE           — when the prompt still grows past a threshold,
//      summarize the conversation and continue with summary + recent turns.
//      Client-side (Claude Code-style) so it works for every provider; the
//      API-native compact-2026-01-12 beta is Anthropic-only.
//   3. Hard token-budget stop — the existing finishRunAuto("token_budget_…
//      reached") guard. Final backstop, never the primary defense.
//
// WHY: a 33-step job-search run measured ~6k input tokens on step 0 growing
// to ~26k by step 33 (606k total) with zero cache writes — unbounded history
// growth is the dominant cost and quality risk of a long-running loop.
//
// Design follows Anthropic's compaction guidance: the summary must preserve
// goal/plan state, decisions + rationale, unresolved problems, key IDs and
// facts, and the current task — and drop verbatim tool output. The rebuilt
// conversation is [summary message, ...last N messages], mirroring the
// pause-after-compaction pattern (summary + preserved recent exchange).
// =============================================================================

import { generateText } from "ai"

export interface CompactionConfig {
  /** Compact when the last turn's input tokens exceed this. */
  compactAtPromptTokens: number
  /** How many trailing messages survive compaction verbatim. */
  keepRecentMessages: number
  /** Total compactions allowed per run (budget guard, Anthropic-recommended). */
  maxCompactionsPerRun: number
}

const DEFAULTS: CompactionConfig = {
  compactAtPromptTokens: 100_000,
  keepRecentMessages: 8,
  maxCompactionsPerRun: 20,
}

function intVar(env: any, key: string, fallback: number): number {
  const raw = env?.[key]
  if (typeof raw !== "string" && typeof raw !== "number") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Env-overridable config: COMPACT_AT_PROMPT_TOKENS / COMPACT_KEEP_RECENT_MESSAGES / MAX_COMPACTIONS_PER_RUN. */
export function getCompactionConfig(env?: any): CompactionConfig {
  return {
    compactAtPromptTokens: intVar(
      env,
      "COMPACT_AT_PROMPT_TOKENS",
      DEFAULTS.compactAtPromptTokens,
    ),
    keepRecentMessages: intVar(
      env,
      "COMPACT_KEEP_RECENT_MESSAGES",
      DEFAULTS.keepRecentMessages,
    ),
    maxCompactionsPerRun: intVar(
      env,
      "MAX_COMPACTIONS_PER_RUN",
      DEFAULTS.maxCompactionsPerRun,
    ),
  }
}

export interface CompactionSignal {
  lastPromptTokens: number
  compactions: number
}

/** True when the guardrail should fire this tick. Pure — unit-tested. */
export function shouldCompact(
  signal: CompactionSignal,
  cfg: CompactionConfig = DEFAULTS,
): boolean {
  if (signal.compactions >= cfg.maxCompactionsPerRun) return false
  return signal.lastPromptTokens >= cfg.compactAtPromptTokens
}

/**
 * Build the post-compaction message list from a summary + the retained tail.
 * Pure — unit-tested.
 *
 * SCHEMA SAFETY: a `role:"tool"` message is only valid immediately after the
 * assistant message carrying its tool-call. Slicing the tail can strand tool
 * messages at the front, so any leading tool messages are dropped (their
 * matching assistant call was cut off with the summarized prefix).
 */
export function buildCompactionMessages(
  summary: string,
  messages: unknown[],
  keepRecent: number,
): any[] {
  // NB: slice(-0) === slice(0) — the whole array. Guard the non-positive case.
  const tail =
    keepRecent <= 0 ? [] : messages.slice(-Math.floor(keepRecent))
  while (tail.length > 0 && (tail[0] as any)?.role === "tool") {
    tail.shift()
  }
  const kickoff = {
    role: "user",
    content:
      `[Compacted history — earlier turns of this run were summarized to free context.]\n\n` +
      `<summary>\n${summary.trim()}\n</summary>\n\n` +
      `Continue the SAME run from this state, using the recent messages that follow. Do not restart the goal or re-do work the summary records as complete.`,
  }
  return [kickoff, ...tail]
}

const SUMMARIZER_SYSTEM = `You compact the running history of an autonomous agent so it can continue the SAME task in a fresh context window. Recall matters more than brevity: the agent will never see the raw history again.

Preserve, concretely:
- The goal, and the plan state (which steps are complete / in-progress / pending, with their results so far)
- Key decisions and WHY they were made
- Unresolved problems, blockers, and dead ends (so they are not retried)
- IDs and facts of record: entity/row IDs, company names, URLs, file paths, memory keys written, numbers the agent cited
- The current task in progress and the concrete next steps

Drop:
- Verbatim tool outputs (they can be re-fetched), redundant restatements, and filler.

Output ONLY the summary — no preamble, no commentary about compaction.`

export interface CompactConversationArgs {
  model: any
  messages: any[]
  goal: string
  planSummary?: string
  /** Extra provider params (getParams) applied to the summarizer call. */
  providerParams?: Record<string, unknown>
}

export interface CompactConversationResult {
  summary: string
  messages: any[]
  /** Output tokens the summarization itself cost (from usage). */
  summaryTokensOut: number | null
}

/**
 * Run one compaction pass: summarize the conversation, then rebuild it as
 * [summary, ...recent tail]. Throws on model failure — the caller's catch
 * keeps the un-compacted conversation running (the guardrail must never kill
 * the run).
 */
export async function compactConversation({
  model,
  messages,
  goal,
  planSummary,
  providerParams,
}: CompactConversationArgs): Promise<CompactConversationResult> {
  const cfg = getCompactionConfig()
  const transcript = JSON.stringify(messages)
  const planBlock = planSummary
    ? `\n\nCurrent plan state:\n${planSummary}`
    : ""
  const result = await generateText({
    model,
    system: SUMMARIZER_SYSTEM,
    prompt:
      `Run goal: ${goal}${planBlock}\n\n` +
      `Full conversation history follows as JSON (messages array):\n\n${transcript}`,
    ...(providerParams ?? {}),
  })
  const summary = (result.text ?? "").trim()
  if (!summary) {
    throw new Error("compaction produced an empty summary")
  }
  return {
    summary,
    messages: buildCompactionMessages(summary, messages, cfg.keepRecentMessages),
    summaryTokensOut:
      typeof result.usage?.outputTokens === "number"
        ? result.usage.outputTokens
        : null,
  }
}

// =============================================================================
// Tool: research — delegate a research task to the ResearchAgent
// =============================================================================
// Sub-agent delegation tools are CAPABILITY PROVIDERS: they stay separate DOs
// so their state survives, but are framed as ground-truth tools the agent calls
// — not competing decision-makers with their own loops.
// =============================================================================
import { tool } from "ai"
import { z } from "zod"
import { getAgentByName } from "agents"
import type { Env } from "../types"
import type { ResearchAgent } from "../agents"
import { withRpcRetry } from "../utils/rpc-retry"

type Advance = (toolName: string, input: string | null) => void

export function makeResearchTool(env: Env, advance: Advance) {
  return tool({
    description:
      "Delegate a research task to the ResearchAgent. It searches arXiv and Hacker News and returns real findings with sources. " +
      "Use when you need facts, trends, or papers you don't already have. Pass a focused topic.",
    inputSchema: z.object({
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
      advance("research", JSON.stringify({ topic, depth }).slice(0, 2000))
      const agent = await getAgentByName<Env, ResearchAgent>(
        env.RESEARCH_AGENT,
        "main",
      )
      // Retry transient RPC failures (DO eviction, network blip) so the run
      // doesn't lose this research turn permanently. See utils/rpc-retry.ts.
      const result = await withRpcRetry(() =>
        agent.research({ topic, depth: depth ?? "standard" }),
      )
      return JSON.stringify(result)
    },
  })
}

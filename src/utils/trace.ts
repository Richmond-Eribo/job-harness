// =============================================================================
// trace.ts — extract the model's reasoning + usage breakdown per turn
// =============================================================================
// WHY THIS EXISTS
// The harness sets `providerOptions.openai.reasoningEffort: "xhigh"` (and the
// Anthropic equivalent `thinking`). When that's on, the AI SDK's `generateText`
// result carries `step.reasoning` — the model's chain-of-thought. The old
// `summarizeStep()` (in run.ts) threw that away and only kept toolName /
// toolArgs / toolOutput. This companion extractor pulls the full per-turn
// trace fields so the dashboard's Trace tab can render the model's thinking.
//
// PROVIDER ROBUSTNESS
// Reasoning text arrives in different shapes across providers / SDK versions:
//   - v5:      step.reasoning (string) OR step.reasoningText
//   - v4:      step.reasoning
//   - OpenAI:  providerMetadata.openai.reasoningTokens (count, not text);
//              some compatible endpoints also expose .reasoning summary
//   - Anthropic: content[] entry { type: "thinking", thinking: "..." }
// Every probe below is null-guarded; if a provider doesn't surface a field we
// store NULL rather than crashing the loop. Silent degradation, never a fault.
// =============================================================================

export interface TraceUsage {
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null // OpenAI reasoning models populate this
  totalTokens: number | null
}

export interface TraceEntry {
  stepNumber: number
  action: string // toolName, or "think" if no tool call
  reasoning: string | null // chain-of-thought (markdown) — token-budget-capped
  text: string | null // full model text output
  toolName: string
  toolArgs: string // JSON string of args
  toolOutput: string | null // JSON string of tool result (truncated)
  usage: TraceUsage
  durationMs: number | null
  model: string | null
  warnings: string[]
}

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null
}

function str(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "string") return v || null
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// Reasoning may land in: step.reasoning (string), step.reasoningText, or buried
// in step.providerMetadata. Probe all the places the AI SDK / providers put it.
function extractReasoning(step: any): string | null {
  if (typeof step?.reasoning === "string" && step.reasoning.trim()) {
    return step.reasoning
  }
  if (typeof step?.reasoningText === "string" && step.reasoningText.trim()) {
    return step.reasoningText
  }
  // OpenAI reasoning often surfaces on the provider-metadata block (esp. on
  // openai-compatible endpoints like GLM, OpenRouter, etc.).
  const pm = step?.providerMetadata
  const openaiReasoning =
    pm?.openai?.reasoning ??
    pm?.openaiCompatible?.reasoning ??
    pm?.providerMetadata?.openai?.reasoning
  if (typeof openaiReasoning === "string" && openaiReasoning.trim()) {
    return openaiReasoning
  }
  // Anthropic-style: thinking is an array of { type: "thinking", thinking: "..." }
  if (Array.isArray(step?.content)) {
    const thinking = step.content
      .filter((b: any) => b?.type === "thinking")
      .map((b: any) => b.thinking)
      .filter(Boolean)
      .join("\n\n")
    if (thinking.trim()) return thinking
  }
  return null
}

export function extractTrace(result: any, stepNumber: number): TraceEntry {
  const steps: any[] = Array.isArray(result?.steps) ? result.steps : []

  // Find the first step with a tool call; else fall back to the last step.
  let step: any = null
  let toolName = ""
  let toolArgs = ""
  let toolOutput: string | null = null

  for (const s of steps) {
    const calls: any[] = Array.isArray(s?.toolCalls) ? s.toolCalls : []
    if (calls.length > 0) {
      step = s
      const c = calls[0]
      toolName = c.toolName ?? ""
      toolArgs = c.args ? JSON.stringify(c.args) : ""
      const tr = Array.isArray(s?.toolResults) ? s.toolResults : []
      toolOutput =
        tr[0]?.result != null
          ? JSON.stringify(tr[0].result).slice(0, 4000)
          : null
      break
    }
  }
  if (!step && steps.length > 0) step = steps[steps.length - 1]

  const usage: TraceUsage = {
    promptTokens: num(step?.usage?.promptTokens ?? result?.usage?.promptTokens),
    completionTokens: num(
      step?.usage?.completionTokens ?? result?.usage?.completionTokens,
    ),
    reasoningTokens: num(
      step?.usage?.reasoningTokens ??
        step?.providerMetadata?.openai?.reasoningTokens ??
        result?.usage?.reasoningTokens,
    ),
    totalTokens: num(result?.usage?.totalTokens ?? step?.usage?.totalTokens),
  }

  const warnings: string[] = Array.isArray(result?.warnings)
    ? result.warnings
        .map((w: any) => (typeof w === "string" ? w : (str(w) ?? "")))
        .filter(Boolean)
    : []

  return {
    stepNumber,
    action: toolName || "think",
    reasoning: extractReasoning(step),
    text: typeof result?.text === "string" ? result.text : null,
    toolName,
    toolArgs,
    toolOutput,
    usage,
    durationMs: null, // set by caller from start/end timestamps
    model: str(result?.response?.model ?? result?.modelId) ?? null,
    warnings,
  }
}

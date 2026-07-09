// =============================================================================
// Model-agnostic LLM factory + shared generation params (BYOK)
// =============================================================================
// Model identity AND generation params (temperature, maxTokens, thinking,
// reasoningEffort) live in src/llm-config.json — NOT in env vars. Env keeps
// only the secret: LLM_API_KEY. Tune behavior by editing the JSON.
//
// ONE shared params block applies to every agent call (harness loop, research,
// job ranking, cover letter, summaries). No per-purpose presets — simpler.
//
// Two protocol flavors are supported side-by-side:
//   - "openai"  block → applied when provider is openai / openai-compatible
//                          (OpenAI, GLM, OpenRouter, xAI, Groq, Ollama…)
//   - "anthropic" block → applied when provider is anthropic / anthropic-compatible
// The block not matching the active provider is simply ignored, so the SAME
// config file works regardless of which model you switch to.
// =============================================================================

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { Env } from "./types"
// JSON imports are statically bundled; no runtime file read needed.
import rawConfig from "./llm-config.json"

// -----------------------------------------------------------------------------
// Types mirroring llm-config.json (kept loose where provider extensions vary).
// -----------------------------------------------------------------------------

export type Provider =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "anthropic-compatible"

interface ModelConfig {
  provider: Provider
  modelId: string
  customProviderUrl?: string
}

interface ParamsConfig {
  $doc?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  responseFormat?: { type: "json" | "text" }
  openai?: Record<string, any> // e.g. { reasoningEffort: "max" }
  anthropic?: Record<string, any> // e.g. { thinking: { type:"enabled", budgetTokens:2048 } }
}

interface LlmConfig {
  model: ModelConfig
  params: ParamsConfig
}

const config = rawConfig as LlmConfig

// -----------------------------------------------------------------------------
// Model factory
// -----------------------------------------------------------------------------

/**
 * Returns a Vercel AI SDK model instance based on llm-config.json + the
 * LLM_API_KEY env secret. Provider/model/baseUrl all come from the config.
 *
 * Supported providers:
 * - "anthropic"            → official Claude API
 * - "openai"               → official OpenAI API
 * - "openai-compatible"    → any /v1/chat/completions endpoint (GLM, OpenRouter,
 *                            xAI, Groq, Ollama, vLLM…). Requires model.customProviderUrl.
 * - "anthropic-compatible" → any /v1/messages endpoint. Requires model.customProviderUrl.
 */
export function getModel(env: Env) {
  const { provider, modelId, customProviderUrl } = config.model
  const apiKey = env.LLM_API_KEY

  if (!apiKey) {
    throw new Error(
      "LLM_API_KEY is not set. Add it to .dev.vars (local) or `wrangler secret put LLM_API_KEY` (production).",
    )
  }

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey })
      return anthropic(modelId)
    }
    case "openai": {
      const openai = createOpenAI({ apiKey })
      return openai(modelId)
    }
    case "openai-compatible": {
      const baseURL = requireCustomUrl(provider, customProviderUrl)
      const openai = createOpenAI({
        apiKey,
        baseURL,
        compatibility: "compatible",
      })
      return openai(modelId)
    }
    case "anthropic-compatible": {
      const baseURL = requireCustomUrl(provider, customProviderUrl)
      const anthropic = createAnthropic({ apiKey, baseURL })
      return anthropic(modelId)
    }
    default:
      throw new Error(
        `Unknown provider "${provider}" in llm-config.json. Supported: ` +
          `anthropic, openai, openai-compatible, anthropic-compatible.`,
      )
  }
}

/** Fail-fast: custom providers MUST declare a base URL in the config. */
function requireCustomUrl(provider: Provider, url: string | undefined): string {
  const trimmed = url?.trim()
  if (!trimmed) {
    throw new Error(
      `provider "${provider}" requires model.customProviderUrl in ` +
        `llm-config.json. e.g. https://openrouter.ai/api/v1 (OpenRouter), ` +
        `https://open.bigmodel.cn/api/paas/v4 (GLM), http://localhost:11434/v1 (Ollama).`,
    )
  }
  return trimmed
}

// -----------------------------------------------------------------------------
// Generation params per preset
// -----------------------------------------------------------------------------

/**
 * Resolve the SHARED generation params (from llm-config.json → params) into the
 * { ...params } object you spread into generateText(). Standard params
 * (maxTokens, temperature, topP) go top-level; provider-specific options
 * (reasoningEffort, thinking) are nested under providerOptions, scoped to
 * whichever provider is active. Safe to spread: empty when unset.
 *
 * One config for every agent call (harness loop, research, jobs, cover letter).
 */
export function getParams(_env: Env) {
  const p: ParamsConfig = config.params ?? {}
  const activeFamily: "openai" | "anthropic" =
    config.model.provider === "anthropic" ||
    config.model.provider === "anthropic-compatible"
      ? "anthropic"
      : "openai"

  const params: Record<string, any> = {}
  if (typeof p.maxTokens === "number") params.maxTokens = p.maxTokens
  if (typeof p.temperature === "number") params.temperature = p.temperature
  if (typeof p.topP === "number") params.topP = p.topP
  if (p.responseFormat) {
    // OpenAI-flavored JSON mode; harmless on providers that ignore it.
    params.responseFormat = p.responseFormat
  }

  // Only the block matching the active protocol family is attached, so the
  // same config works whether you point at OpenAI or Anthropic APIs.
  const familyOpts = p[activeFamily] ?? {}
  if (Object.keys(familyOpts).length > 0) {
    params.providerOptions = { [activeFamily]: familyOpts }
  }

  return params
}

// -----------------------------------------------------------------------------
// Metadata (for dashboard / status display)
// -----------------------------------------------------------------------------

export function getModelInfo(_env: Env): {
  provider: string
  model: string
  endpoint?: string
} {
  return {
    provider: config.model.provider,
    model: config.model.modelId,
    endpoint:
      config.model.customProviderUrl &&
      config.model.customProviderUrl.trim().length > 0
        ? config.model.customProviderUrl
        : undefined,
  }
}

// =============================================================================
// Model-agnostic LLM factory + shared generation params (BYOK)
// =============================================================================
// Model identity AND generation params (temperature, maxTokens, thinking,
// reasoningEffort) live in src/llm-config.json — NOT in env vars. Env keeps
// only the secret: LLM_API_KEY. Tune behavior by editing the JSON.
//
// ONE shared params block applies to every agent call (harness loop,
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
// All non-secret JSON config lives under src/config/* (single convention).
import rawConfig from "./config/llm-config.json"

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
  openai?: Record<string, any> // e.g. { reasoningEffort: "xhigh" }
  anthropic?: Record<string, any> // e.g. { thinking: { type:"enabled", budgetTokens:2048 } }
}

interface LlmConfig {
  model: ModelConfig
  params: ParamsConfig
}

const config = rawConfig as LlmConfig

// ───────────────────────────────────────────────────────────────────────
// Runtime model override (v1 gap fix)
// ───────────────────────────────────────────────────────────────────────
// llm-config.json is a static import (baked at build time), so without this
// override mechanism the operator can't switch providers/models without a
// redeploy. setModelOverride() takes a partial ModelConfig (provider, modelId,
// customProviderUrl) — anything unset falls back to the JSON. The harness
// reads overrides from the `config` SQLite table during ensureDb() and applies
// them here, so PUT /api/config { llmProvider, llmModel, customProviderUrl }
// takes effect on the next getModel() call without a redeploy.
let modelOverride: Partial<ModelConfig> = {}

export function setModelOverride(override: Partial<ModelConfig>): void {
  modelOverride = override
}

export function clearModelOverride(): void {
  modelOverride = {}
}

/** The runtime-effective model config (JSON merged with any DB override). */
export function effectiveModelConfig(): ModelConfig {
  return {
    provider: modelOverride.provider ?? config.model.provider,
    modelId: modelOverride.modelId ?? config.model.modelId,
    customProviderUrl:
      modelOverride.customProviderUrl ?? config.model.customProviderUrl,
  }
}

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
  const { provider, modelId, customProviderUrl } = effectiveModelConfig()
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
      // `compatibility: "compatible"` was removed in @ai-sdk/openai v4. The
      // default openai(modelId) routes to OpenAI's Responses API (/responses),
      // which official OpenAI supports but most compatible gateways (z.ai,
      // OpenRouter, Groq, vLLM…) do NOT — they only implement the classic
      // Chat Completions API (/chat/completions) and 404 on /responses. So for
      // a compatible provider we MUST explicitly use .chat(modelId), which
      // targets /chat/completions. (For the official "openai" case above we
      // keep the default Responses API.)
      const openai = createOpenAI({
        apiKey,
        baseURL,
      })
      return openai.chat(modelId)
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
        `https://open.bigmodel.cn/api/paas/v4 (GLM),`,
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
 * One config for every agent call (harness loop, jobs, cover letter).
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
  const m = effectiveModelConfig()
  return {
    provider: m.provider,
    model: m.modelId,
    endpoint:
      m.customProviderUrl && m.customProviderUrl.trim().length > 0
        ? m.customProviderUrl
        : undefined,
  }
}

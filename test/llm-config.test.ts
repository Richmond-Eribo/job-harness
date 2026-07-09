import { describe, it, expect } from "vitest"

/**
 * Tests for the LLM config loading and parameter resolution logic.
 * We test the pure functions that don't require Cloudflare bindings.
 */

// Mock the config shape
interface ModelConfig {
  provider: string
  modelId: string
  customProviderUrl?: string
}

interface ParamsConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
  responseFormat?: { type: "json" | "text" }
  openai?: Record<string, any>
  anthropic?: Record<string, any>
}

interface LlmConfig {
  model: ModelConfig
  params: ParamsConfig
}

// Replicate the getParams logic from src/llm.ts
function getParams(config: LlmConfig) {
  const p = config.params ?? {}
  const activeFamily: "openai" | "anthropic" =
    config.model.provider === "anthropic" ||
    config.model.provider === "anthropic-compatible"
      ? "anthropic"
      : "openai"

  const params: Record<string, any> = {}
  if (typeof p.maxTokens === "number") params.maxTokens = p.maxTokens
  if (typeof p.temperature === "number") params.temperature = p.temperature
  if (typeof p.topP === "number") params.topP = p.topP
  if (p.responseFormat) params.responseFormat = p.responseFormat

  const familyOpts = p[activeFamily] ?? {}
  if (Object.keys(familyOpts).length > 0) {
    params.providerOptions = { [activeFamily]: familyOpts }
  }

  return params
}

function getModelInfo(config: LlmConfig) {
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

describe("getParams", () => {
  it("returns openai providerOptions for openai-compatible provider", () => {
    const config: LlmConfig = {
      model: {
        provider: "openai-compatible",
        modelId: "GLM-5.2",
        customProviderUrl: "https://api.z.ai/api/coding/paas/v4",
      },
      params: {
        maxTokens: 128000,
        temperature: 0.6,
        openai: { reasoningEffort: "xhigh" },
        anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
      },
    }

    const params = getParams(config)
    expect(params.maxTokens).toBe(128000)
    expect(params.temperature).toBe(0.6)
    expect(params.providerOptions).toEqual({
      openai: { reasoningEffort: "xhigh" },
    })
    // Anthropic block should NOT be attached for openai-compatible
    expect(params.providerOptions?.anthropic).toBeUndefined()
  })

  it("returns anthropic providerOptions for anthropic provider", () => {
    const config: LlmConfig = {
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      },
      params: {
        maxTokens: 8192,
        temperature: 0.7,
        openai: { reasoningEffort: "max" },
        anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
      },
    }

    const params = getParams(config)
    expect(params.maxTokens).toBe(8192)
    expect(params.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    })
    // OpenAI block should NOT be attached for anthropic
    expect(params.providerOptions?.openai).toBeUndefined()
  })

  it("handles empty params gracefully", () => {
    const config: LlmConfig = {
      model: { provider: "openai", modelId: "gpt-4" },
      params: {},
    }

    const params = getParams(config)
    expect(params).toEqual({})
  })

  it("only attaches providerOptions when family opts exist", () => {
    const config: LlmConfig = {
      model: { provider: "openai", modelId: "gpt-4" },
      params: {
        maxTokens: 4096,
        temperature: 0.5,
      },
    }

    const params = getParams(config)
    expect(params.maxTokens).toBe(4096)
    expect(params.temperature).toBe(0.5)
    expect(params.providerOptions).toBeUndefined()
  })
})

describe("getModelInfo", () => {
  it("returns provider and model", () => {
    const config: LlmConfig = {
      model: { provider: "openai", modelId: "gpt-4" },
      params: {},
    }

    const info = getModelInfo(config)
    expect(info).toEqual({ provider: "openai", model: "gpt-4" })
  })

  it("includes endpoint when customProviderUrl is set", () => {
    const config: LlmConfig = {
      model: {
        provider: "openai-compatible",
        modelId: "GLM-5.2",
        customProviderUrl: "https://api.z.ai/api/coding/paas/v4",
      },
      params: {},
    }

    const info = getModelInfo(config)
    expect(info.endpoint).toBe("https://api.z.ai/api/coding/paas/v4")
  })

  it("omits endpoint when customProviderUrl is empty", () => {
    const config: LlmConfig = {
      model: {
        provider: "openai-compatible",
        modelId: "GLM-5.2",
        customProviderUrl: "   ",
      },
      params: {},
    }

    const info = getModelInfo(config)
    expect(info.endpoint).toBeUndefined()
  })
})

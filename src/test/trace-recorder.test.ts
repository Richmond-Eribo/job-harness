import { describe, it, expect } from "vitest"
import { TraceRecorder, ingestSubAgentTrace } from "../utils/trace-recorder"
import type { TraceEventInput } from "../types"

/**
 * Tests for the shared TraceRecorder — the capture path used by BOTH the
 * harness streamText loop and the sub-agent generateText loops.
 *
 * These exercise the recorder in isolation (no DB, no LLM call): we feed it
 * the same chunk/step/tool shapes the AI SDK v7 emits and assert it buffers
 * correctly-shaped events. The sink is a plain array so we can inspect what
 * would be written to trace_events.
 */

function makeRecorder(opts: Partial<TraceRecorderOptions> = {}) {
  const sink: TraceEventInput[] = []
  const rec = new TraceRecorder({
    agent: opts.agent ?? "harness",
    runId: opts.runId ?? "run-test",
    redactKeys: opts.redactKeys ?? [],
    sink: ev => sink.push(ev),
  })
  return { rec, sink }
}

// minimal options type to avoid importing the private interface
type TraceRecorderOptions = {
  agent?: any
  runId?: string
  redactKeys?: string[]
  sink?: (ev: TraceEventInput) => void
}

describe("TraceRecorder — basic event recording", () => {
  it("records a run_start event with goal + budgets", () => {
    const { rec, sink } = makeRecorder()
    rec.recordRunStart("find jobs", 50, 100000)
    expect(sink).toHaveLength(1)
    const ev = sink[0]
    expect(ev.eventType).toBe("run_start")
    expect(ev.agent).toBe("harness")
    expect(JSON.parse(ev.payload!)).toEqual({
      goal: "find jobs",
      maxSteps: 50,
      tokenBudget: 100000,
    })
  })

  it("records a system prompt event", () => {
    const { rec, sink } = makeRecorder()
    rec.recordSystem("system-prompt", "You are an agent.")
    expect(sink[0].eventType).toBe("system")
    expect(sink[0].role).toBe("system")
    expect(sink[0].label).toBe("system-prompt")
    expect(sink[0].payload).toBe("You are an agent.")
  })

  it("records a prompt event with the messages array", () => {
    const { rec, sink } = makeRecorder()
    rec.recordPrompt(2, [{ role: "user", content: "go" }])
    expect(sink[0].eventType).toBe("prompt")
    expect(sink[0].stepNumber).toBe(2)
    expect(sink[0].role).toBe("user")
    expect(JSON.parse(sink[0].payload!)[0].content).toBe("go")
  })

  it("tags every event with the owning agent", () => {
    const { rec, sink } = makeRecorder({ agent: "job-agent" })
    rec.recordError(0, "boom")
    expect(sink[0].agent).toBe("job-agent")
  })
})

describe("TraceRecorder — onStepEnd emits authoritative step_end + flushes buffers", () => {
  it("accumulates text-delta chunks via onChunk and flushes them on onStepEnd", () => {
    const { rec, sink } = makeRecorder()
    const cb = rec.attach(0)
    // v7 field name is chunk.text (NOT textDelta)
    cb.onChunk({ chunk: { type: "text-delta", text: "Hello " } })
    cb.onChunk({ chunk: { type: "text-delta", text: "world" } })

    cb.onStepEnd({
      stepNumber: 0,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: 3 },
        outputTokenDetails: { reasoningTokens: 8 },
      },
      response: { modelId: "GLM-5.2", messages: [] },
      finishReason: "stop",
      performance: { stepTimeMs: 1500 },
      warnings: [],
    })

    const types = sink.map(e => e.eventType)
    expect(types).toContain("text")
    expect(types).toContain("step_end")
    const textEv = sink.find(e => e.eventType === "text")
    expect(textEv!.payload).toBe("Hello world")
    const stepEnd = sink.find(e => e.eventType === "step_end")
    expect(stepEnd!.tokensIn).toBe(100)
    expect(stepEnd!.tokensOut).toBe(20)
    expect(stepEnd!.tokensReasoning).toBe(8)
    expect(stepEnd!.cacheRead).toBe(5)
    expect(stepEnd!.cacheWrite).toBe(3)
    expect(stepEnd!.model).toBe("GLM-5.2")
    expect(stepEnd!.label).toBe("stop") // finishReason
    expect(stepEnd!.durationMs).toBe(1500)
  })

  it("accumulates reasoning-delta chunks via chunk.text", () => {
    const { rec, sink } = makeRecorder()
    const cb = rec.attach(1)
    cb.onChunk({ chunk: { type: "reasoning-delta", text: "thinking..." } })
    cb.onStepEnd({ stepNumber: 1, usage: {}, response: { messages: [] }, performance: {} })
    const reasoningEv = sink.find(e => e.eventType === "reasoning")
    expect(reasoningEv).toBeDefined()
    expect(reasoningEv!.payload).toBe("thinking...")
  })
})

describe("TraceRecorder — tool call / result pairing via toolCallId", () => {
  it("records a tool_call and pairs its result by toolCallId", () => {
    const { rec, sink } = makeRecorder()
    const cb = rec.attach(0)
    // The streaming tool-call chunk (model decided to call a tool)
    cb.onChunk({
      chunk: {
        type: "tool-call",
        toolName: "discover_jobs",
        toolCallId: "call_abc",
        input: { criteria: "senior TS", maxResults: 5 },
      },
    })
    // The tool finished executing
    cb.onToolExecutionEnd({
      toolCall: { toolName: "discover_jobs", toolCallId: "call_abc" },
      toolOutput: { type: "tool-result", output: { newListings: [] } },
      toolExecutionMs: 420,
    })

    const call = sink.find(
      e => e.eventType === "tool_call" && e.toolCallId === "call_abc",
    )
    const result = sink.find(
      e => e.eventType === "tool_result" && e.toolCallId === "call_abc",
    )
    expect(call).toBeDefined()
    expect(result).toBeDefined()
    expect(call!.label).toBe("discover_jobs")
    expect(result!.durationMs).toBe(420)
    // args + result are JSON strings
    expect(JSON.parse(call!.payload!)).toEqual({
      criteria: "senior TS",
      maxResults: 5,
    })
    expect(JSON.parse(result!.payload!)).toEqual({ newListings: [] })
  })
})

describe("TraceRecorder — redaction", () => {
  it("redacts sensitive keys in tool args and results", () => {
    const { rec, sink } = makeRecorder({
      redactKeys: ["apiKey", "token"],
    })
    const cb = rec.attach(0)
    cb.onChunk({
      chunk: {
        type: "tool-call",
        toolName: "fetch_page",
        toolCallId: "call_x",
        input: { url: "https://x", apiKey: "sk-secret" },
      },
    })
    cb.onToolExecutionEnd({
      toolCall: { toolName: "fetch_page", toolCallId: "call_x" },
      toolOutput: {
        type: "tool-result",
        output: { token: "abc", data: "ok" },
      },
      toolExecutionMs: 10,
    })
    const call = sink.find(e => e.eventType === "tool_call")
    const result = sink.find(e => e.eventType === "tool_result")
    expect(JSON.parse(call!.payload!).apiKey).toBe("[redacted]")
    expect(JSON.parse(call!.payload!).url).toBe("https://x")
    expect(JSON.parse(result!.payload!).token).toBe("[redacted]")
    expect(JSON.parse(result!.payload!).data).toBe("ok")
  })
})

describe("TraceRecorder — sub-agent trace ingestion", () => {
  it("ingestSubAgentTrace writes nested events with parentId + agent label", () => {
    const harnessSink: TraceEventInput[] = []
    const sub: any = {
      agent: "job-agent",
      events: [
        { eventType: "tool_call", label: "search_site", toolCallId: "sub_1" },
        { eventType: "tool_result", label: "search_site", toolCallId: "sub_1" },
      ],
    }
    ingestSubAgentTrace(sub, "call_abc", "discover_jobs", ev =>
      harnessSink.push(ev),
    )
    expect(harnessSink).toHaveLength(2)
    for (const ev of harnessSink) {
      expect(ev.parentId).toBe("call_abc")
      expect(ev.parentLabel).toBe("discover_jobs")
      expect(ev.agent).toBe("job-agent")
    }
  })

  it("ingestSubAgentTrace is a no-op for empty/null sub-traces", () => {
    const sink: TraceEventInput[] = []
    ingestSubAgentTrace(null, "p", "t", ev => sink.push(ev))
    ingestSubAgentTrace({ agent: "job-agent", events: [] }, "p", "t", ev =>
      sink.push(ev),
    )
    expect(sink).toHaveLength(0)
  })
})

describe("TraceRecorder — flushFallback (safety net)", () => {
  it("emits a minimal step_end when onStepEnd never fired", () => {
    const { rec, sink } = makeRecorder()
    // No onStepEnd call — directly flush.
    rec.flushFallback(0, Date.now() - 1000, {
      usage: { inputTokens: 10, outputTokens: 5 },
      response: { modelId: "gpt-4o", messages: [] },
      finishReason: "stop",
      warnings: [],
    })
    const stepEnd = sink.find(e => e.eventType === "step_end")
    expect(stepEnd).toBeDefined()
    expect(stepEnd!.tokensIn).toBe(10)
    expect(stepEnd!.tokensOut).toBe(5)
    expect(stepEnd!.model).toBe("gpt-4o")
  })

  it("does not double-emit step_end if onStepEnd already fired", () => {
    const { rec, sink } = makeRecorder()
    const cb = rec.attach(0)
    cb.onStepEnd({ stepNumber: 0, usage: {}, response: { messages: [] }, performance: {} })
    const afterStep = sink.length
    rec.flushFallback(0, Date.now(), {
      usage: { inputTokens: 1 },
      response: {},
      finishReason: "stop",
    })
    // No additional step_end should be emitted.
    expect(sink.filter(e => e.eventType === "step_end")).toHaveLength(1)
    expect(sink.length).toBe(afterStep)
  })
})

describe("TraceRecorder — toSubAgentTrace", () => {
  it("returns the buffer for RPC transport", () => {
    const { rec } = makeRecorder({ agent: "research-agent" })
    rec.recordSystem("system-prompt", "sys")
    rec.recordError(0, "x")
    const sub = rec.toSubAgentTrace()
    expect(sub.agent).toBe("research-agent")
    expect(sub.events).toHaveLength(2)
  })
})

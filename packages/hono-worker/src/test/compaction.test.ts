// -----------------------------------------------------------------------------
// compaction — the mid-run context guardrail (Anthropic-style, client-side).
// Pure logic is tested directly; the generateText-backed compactConversation
// is tested with the `ai` module mocked.
// -----------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest"

const generateTextMock = vi.hoisted(() => vi.fn())

vi.mock("ai", () => ({
  generateText: generateTextMock,
}))

import {
  getCompactionConfig,
  shouldCompact,
  buildCompactionMessages,
  compactConversation,
} from "../agents/compaction"

describe("shouldCompact", () => {
  const cfg = { compactAtPromptTokens: 1000, keepRecentMessages: 8, maxCompactionsPerRun: 3 }

  it("does not fire below the threshold", () => {
    expect(shouldCompact({ lastPromptTokens: 999, compactions: 0 }, cfg)).toBe(false)
  })

  it("fires at and above the threshold", () => {
    expect(shouldCompact({ lastPromptTokens: 1000, compactions: 0 }, cfg)).toBe(true)
    expect(shouldCompact({ lastPromptTokens: 50_000, compactions: 0 }, cfg)).toBe(true)
  })

  it("never exceeds the per-run budget", () => {
    expect(shouldCompact({ lastPromptTokens: 50_000, compactions: 3 }, cfg)).toBe(false)
  })
})

describe("getCompactionConfig", () => {
  it("uses defaults when env is empty", () => {
    const cfg = getCompactionConfig(undefined)
    expect(cfg.compactAtPromptTokens).toBe(100_000)
    expect(cfg.keepRecentMessages).toBe(8)
    expect(cfg.maxCompactionsPerRun).toBe(20)
  })

  it("accepts env overrides and rejects garbage", () => {
    const cfg = getCompactionConfig({
      COMPACT_AT_PROMPT_TOKENS: "4200",
      COMPACT_KEEP_RECENT_MESSAGES: "5",
      MAX_COMPACTIONS_PER_RUN: "nope",
    })
    expect(cfg.compactAtPromptTokens).toBe(4200)
    expect(cfg.keepRecentMessages).toBe(5)
    expect(cfg.maxCompactionsPerRun).toBe(20) // garbage falls back
  })
})

describe("buildCompactionMessages", () => {
  const user = (t: string) => ({ role: "user", content: t })
  const assistant = (t: string) => ({ role: "assistant", content: t })
  const toolMsg = (id: string) => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, output: { type: "text", value: "x" } }],
  })

  it("returns [summary kickoff, ...last N messages]", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")]
    const out = buildCompactionMessages("SUM", msgs, 2)
    expect(out).toHaveLength(3)
    expect(out[0].role).toBe("user")
    expect(out[0].content).toContain("<summary>")
    expect(out[0].content).toContain("SUM")
    expect(out.slice(1)).toEqual([user("c"), assistant("d")])
  })

  it("keeps interior tool messages that stay paired with their assistant call", () => {
    const msgs = [
      user("a"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "x", input: {} }] },
      toolMsg("t1"),
      user("b"),
    ]
    const out = buildCompactionMessages("SUM", msgs, 3)
    // tail = [assistant(call), tool(t1), user(b)] — valid order, nothing dropped
    expect(out).toHaveLength(4)
    expect(out[1].role).toBe("assistant")
    expect(out[2].role).toBe("tool")
  })

  it("shifts tool messages that land at the head of the tail", () => {
    const msgs = [user("a"), assistant("b"), toolMsg("t1"), toolMsg("t2"), user("c")]
    // slice(-3) = [toolMsg(t2), user("c")] → leading tool message dropped
    const out = buildCompactionMessages("SUM", msgs, 3)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe("user")
    expect(out[1]).toEqual(user("c"))
  })

  it("keepRecent 0 yields just the summary message", () => {
    const out = buildCompactionMessages("SUM", [user("a"), assistant("b")], 0)
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain("SUM")
  })
})

describe("compactConversation (generateText mocked)", () => {
  beforeEach(() => {
    generateTextMock.mockReset()
  })

  it("summarizes and rebuilds messages as summary + tail", async () => {
    generateTextMock.mockResolvedValue({
      text: "  The agent discovered 10 jobs and drafted 5.  ",
      usage: { outputTokens: 321 },
    })
    const model = { id: "test-model" }
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: "working" },
    ]
    const out = await compactConversation({ model, messages: msgs, goal: "find jobs" })
    expect(out.summary).toBe("The agent discovered 10 jobs and drafted 5.")
    expect(out.summaryTokensOut).toBe(321)
    expect(out.messages[0].role).toBe("user")
    expect(out.messages[0].content).toContain("<summary>")
    expect(out.messages).toHaveLength(3) // summary + both messages

    const call = generateTextMock.mock.calls[0][0]
    expect(call.model).toBe(model)
    expect(call.prompt).toContain("find jobs")
    expect(call.prompt).toContain('"go"') // transcript embedded
  })

  it("forwards plan state into the prompt when provided", async () => {
    generateTextMock.mockResolvedValue({ text: "s", usage: {} })
    await compactConversation({
      model: {},
      messages: [{ role: "user", content: "x" }],
      goal: "g",
      planSummary: "step 1 done",
    })
    expect(generateTextMock.mock.calls[0][0].prompt).toContain("step 1 done")
  })

  it("throws on an empty summary so the caller keeps the un-compacted history", async () => {
    generateTextMock.mockResolvedValue({ text: "   ", usage: {} })
    await expect(
      compactConversation({ model: {}, messages: [], goal: "g" }),
    ).rejects.toThrow(/empty summary/)
  })
})

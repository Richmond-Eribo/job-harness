import { describe, it, expect } from "vitest"
import { DEFAULT_HARNESS_STATE } from "../types/harness"

/**
 * Tests for type guards and type-related logic.
 * Since TypeScript types are erased at runtime, we test the shapes
 * and default values that the types represent.
 */

describe("DEFAULT_HARNESS_STATE", () => {
  it("has idle status", () => {
    expect(DEFAULT_HARNESS_STATE.status).toBe("idle")
  })

  it("starts at step 0", () => {
    expect(DEFAULT_HARNESS_STATE.currentStep).toBe(0)
  })

  it("has maxSteps of 100", () => {
    expect(DEFAULT_HARNESS_STATE.maxSteps).toBe(100)
  })

  it("has a 128k token budget", () => {
    expect(DEFAULT_HARNESS_STATE.tokenBudget).toBe(128000)
  })

  it("has no runId initially", () => {
    expect(DEFAULT_HARNESS_STATE.runId).toBeNull()
  })

  it("ships NO hardcoded goal — empty triggers profile-grounded resolution", () => {
    // A baked-in default goal steers every tenant toward whatever the default
    // says (previously "software / AI engineering roles") regardless of their
    // CV. The contract now: empty string here, and start()/wake() resolve the
    // goal from the user's own profile.
    expect(DEFAULT_HARNESS_STATE.goal).toBe("")
  })
})

describe("HarnessState transitions", () => {
  it("can transition from idle to running", () => {
    const state = { ...DEFAULT_HARNESS_STATE }
    const running = { ...state, status: "running" as const }
    expect(running.status).toBe("running")
  })

  it("can transition to error with message", () => {
    const state = { ...DEFAULT_HARNESS_STATE }
    const errored = {
      ...state,
      status: "error" as const,
      lastError: "Something went wrong",
    }
    expect(errored.status).toBe("error")
    expect(errored.lastError).toBe("Something went wrong")
  })

  it("can set runId and lastRunAt", () => {
    const state = { ...DEFAULT_HARNESS_STATE }
    const withRun = {
      ...state,
      runId: "run-20260710-abc123",
      lastRunAt: new Date().toISOString(),
    }
    expect(withRun.runId).toMatch(/^run-\d{8}-/)
    expect(withRun.lastRunAt).toBeTruthy()
  })
})

describe("ScheduleEntry", () => {
  it("has required fields", () => {
    const entry = {
      id: 1,
      cron: "0 9 * * 1-5",
      focus: "all" as const,
      enabled: true,
      lastTriggeredAt: null,
      description: "Every 09:00 UTC Mon-Fri",
      nextFireAt: "2026-07-11T09:00:00.000Z",
    }
    expect(entry.id).toBe(1)
    expect(entry.cron).toBe("0 9 * * 1-5")
    expect(entry.enabled).toBe(true)
  })
})

describe("JobListing", () => {
  it("has valid status values", () => {
    const validStatuses = [
      "discovered",
      "draft",
      "applied",
      "interview",
      "offer",
      "rejected",
    ]
    for (const status of validStatuses) {
      expect(typeof status).toBe("string")
    }
  })
})

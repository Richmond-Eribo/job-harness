import { describe, it, expect } from "vitest"

// Test the REAL cron helpers, not a local copy. Previously this file
// re-declared validateCron/previousFire/nextFire/describeCron inline, which
// meant the suite would keep passing even if src/utils/cron.ts diverged.
import {
  validateCron,
  previousFire,
  nextFire,
  describeCron,
} from "../utils/cron"

describe("validateCron", () => {
  it("accepts standard 5-field cron expressions", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull()
    expect(validateCron("*/2 * * * *")).toBeNull()
    expect(validateCron("0 0 * * 0")).toBeNull()
    expect(validateCron("30 14 * * *")).toBeNull()
  })

  it("rejects truly invalid cron expressions", () => {
    // cron-parser v5 is lenient about some things but rejects truly broken syntax
    expect(validateCron("not a cron at all!!!")).toBeTruthy()
  })

  it("accepts expressions with various field counts", () => {
    // cron-parser v5 accepts 3-field (seconds omitted) and 6-field (seconds included)
    expect(validateCron("* * *")).toBeNull()
    expect(validateCron("* * * * * *")).toBeNull()
  })

  it("rejects out-of-range values", () => {
    // cron-parser v5 rejects values outside valid ranges
    expect(validateCron("99 99 * * *")).toBeTruthy()
  })
})

describe("previousFire", () => {
  it("returns a date in the past for valid expressions", () => {
    const now = new Date("2026-07-10T12:00:00Z")
    const prev = previousFire("0 9 * * *", now)
    expect(prev).toBeInstanceOf(Date)
    expect(prev!.getTime()).toBeLessThanOrEqual(now.getTime())
  })

  it("returns null for invalid expressions", () => {
    expect(previousFire("invalid")).toBeNull()
  })

  it("handles step expressions correctly", () => {
    const now = new Date("2026-07-10T12:00:00Z")
    const prev = previousFire("*/15 * * * *", now)
    expect(prev).toBeInstanceOf(Date)
    expect(prev!.getTime()).toBeLessThanOrEqual(now.getTime())
  })
})

describe("nextFire", () => {
  it("returns a date in the future for valid expressions", () => {
    const now = new Date("2026-07-10T12:00:00Z")
    const next = nextFire("0 9 * * *", now)
    expect(next).toBeInstanceOf(Date)
    expect(next!.getTime()).toBeGreaterThanOrEqual(now.getTime())
  })

  it("returns null for invalid expressions", () => {
    expect(nextFire("invalid")).toBeNull()
  })
})

describe("describeCron", () => {
  it("describes daily weekday schedules", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Every 09:00 UTC Mon-Fri")
  })

  it("describes weekend schedules", () => {
    expect(describeCron("0 10 * * 0,6")).toBe("Every 10:00 UTC Sat-Sun")
  })

  it("returns raw expression for non-standard patterns", () => {
    expect(describeCron("*/2 * * * *")).toBe("*/2 * * * *")
  })

  it("handles wrong field count gracefully", () => {
    expect(describeCron("* * *")).toBe("* * *")
  })
})

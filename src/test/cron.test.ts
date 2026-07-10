import { describe, it, expect } from "vitest"
import { CronExpressionParser } from "cron-parser"

/**
 * These mirror the pure cron helpers in src/harness.ts.
 * We test the underlying logic since the harness functions are private.
 */

function validateCron(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr, { currentDate: new Date(), tz: "UTC" })
    return null
  } catch (e: any) {
    return e?.message ?? "Invalid cron expression"
  }
}

function previousFire(expr: string, now: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.prev().toDate()
  } catch {
    return null
  }
}

function nextFire(expr: string, now: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.next().toDate()
  } catch {
    return null
  }
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [minP, hourP, , , dowP] = parts
  const at =
    hourP !== "*" && minP !== "*"
      ? `${hourP.padStart(2, "0")}:${minP.padStart(2, "0")}`
      : ""
  const days =
    dowP === "*"
      ? ""
      : dowP === "1-5"
        ? " Mon-Fri"
        : dowP === "0,6"
          ? " Sat-Sun"
          : ` ${dowP}`
  if (at) return `Every ${at} UTC${days}`
  return expr
}

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

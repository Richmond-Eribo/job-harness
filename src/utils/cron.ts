// =============================================================================
// Cron helpers (backed by cron-parser — full 5-field cron: ranges, steps,
// lists, named days/months, AND intelligence for "did we miss a window?").
// =============================================================================

import { CronExpressionParser } from "cron-parser"

/**
 * Validate a cron expression. Returns an error message string, or null if OK.
 */
export function validateCron(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr, { currentDate: new Date(), tz: "UTC" })
    return null
  } catch (e: any) {
    return e?.message ?? "Invalid cron expression"
  }
}

/**
 * The previous time the given cron should have fired, strictly before `now`.
 * Returns null if the expression is invalid (so a bad schedule can't crash the
 * watchdog — it just never fires).
 */
export function previousFire(
  expr: string,
  now: Date = new Date(),
): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.prev().toDate() // most-recent fire at-or-before now
  } catch {
    return null
  }
}

/**
 * The next time the given cron will fire, at-or-after `now`.
 */
export function nextFire(expr: string, now: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: now, tz: "UTC" })
    return it.next().toDate()
  } catch {
    return null
  }
}

/**
 * Human-readable description of when a cron fires (e.g. "At 09:00, Mon-Fri").
 * Falls back to the raw expression if summarization isn't feasible.
 */
export function describeCron(expr: string): string {
  // Lightweight, predictable description — avoids pulling in a separate
  // "cronstrue" dep. We translate the most common constructs the dashboard
  // would accept; everything else shows the raw expression.
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

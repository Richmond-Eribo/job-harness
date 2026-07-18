import { describe, it, expect } from "vitest"

/**
 * Tests that initDb issues ONE statement per query (the Agents SDK's sql tagged
 * template cannot execute multiple statements in a single call) and that all DB
 * access now flows through the agent instance (src/db.ts execSql), not a
 * detached `this.sql` reference.
 */

describe("initDb SQL splitting", () => {
  it("splits CREATE TABLE statements into individual calls in harness.ts", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "agents", "harness.ts"),
      "utf-8",
    )

    // Should NOT have multi-statement SQL (multiple CREATE TABLE in one string)
    const multiStatementPattern =
      /execSql\(\s*(?:sql|agent),\s*`[^`]*CREATE TABLE[^`]*CREATE TABLE/s
    expect(multiStatementPattern.test(src)).toBe(false)

    // Should have individual CREATE TABLE statements
    const createTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) || [])
      .length
    expect(createTableCount).toBe(8) // context, step_log, daily_summaries, schedules, config, trace_events, user_memory, run_checkpoints
  })

  it("splits CREATE TABLE statements into individual calls in job-agent.ts", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "agents", "job-agent.ts"),
      "utf-8",
    )

    const multiStatementPattern =
      /execSql\(\s*(?:sql|agent),\s*`[^`]*CREATE TABLE[^`]*CREATE TABLE/s
    expect(multiStatementPattern.test(src)).toBe(false)

    const createTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) || [])
      .length
    // 5 real tables (user_profile, job_listings, cover_letters, follow_ups,
    // job_sources) + 1 match from the doc comment "...CREATE TABLE IF NOT
    // EXISTS is idempotent..." in ensureDb().
    expect(createTableCount).toBe(6)
  })
})

describe("execSql binding source guard", () => {
  // Regression guard for the production crash:
  //   "TypeError: Cannot read properties of undefined (reading 'ctx')".
  // execSql must receive the AGENT instance (this), never a detached this.sql.
  const agents = [
    ["agents/harness.ts", "harness"],
    ["agents/job-agent.ts", "job-agent"],
  ] as const

  for (const [file, name] of agents) {
    it(`${name}: never passes a detached this.sql to execSql`, () => {
      const fs = require("fs")
      const path = require("path")
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf-8")

      // The OLD buggy pattern: passing the method reference directly.
      expect(src).not.toMatch(/execSql\(\s*this\.sql\b/)
      // initDb / getProfileString likewise must take the agent, not this.sql.
      expect(src).not.toMatch(/initDb\(\s*this\.sql\)/)
      expect(src).not.toMatch(/getProfileString\(\s*this\.sql\)/)
    })
  }
})

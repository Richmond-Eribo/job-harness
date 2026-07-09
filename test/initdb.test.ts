import { describe, it, expect } from "vitest"

/**
 * Tests for the initDb SQL splitting fix.
 * Verifies that multi-statement SQL is split into individual statements
 * for Agent SDK compatibility.
 */

describe("initDb SQL splitting", () => {
  it("splits CREATE TABLE statements into individual calls in harness.ts", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "harness.ts"),
      "utf-8",
    )

    // Should NOT have multi-statement SQL (multiple CREATE TABLE in one string)
    const multiStatementPattern = /execSql\(\s*sql,\s*`[^`]*CREATE TABLE[^`]*CREATE TABLE/s
    expect(multiStatementPattern.test(src)).toBe(false)

    // Should have individual CREATE TABLE statements
    const createTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) || []).length
    expect(createTableCount).toBe(5) // context, step_log, daily_summaries, schedules, config
  })

  it("splits CREATE TABLE statements into individual calls in job-agent.ts", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "job-agent.ts"),
      "utf-8",
    )

    const multiStatementPattern = /execSql\(\s*sql,\s*`[^`]*CREATE TABLE[^`]*CREATE TABLE/s
    expect(multiStatementPattern.test(src)).toBe(false)

    const createTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) || []).length
    expect(createTableCount).toBe(4) // user_profile, job_listings, cover_letters, follow_ups
  })

  it("splits CREATE TABLE statements into individual calls in research-agent.ts", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "research-agent.ts"),
      "utf-8",
    )

    const multiStatementPattern = /execSql\(\s*sql,\s*`[^`]*CREATE TABLE[^`]*CREATE TABLE/s
    expect(multiStatementPattern.test(src)).toBe(false)

    const createTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) || []).length
    expect(createTableCount).toBe(2) // research_results, research_topics
  })
})

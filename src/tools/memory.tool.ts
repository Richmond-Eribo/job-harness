// =============================================================================
// Memory tools — explicit agent-controlled key/value store across runs.
//   remember → persist a durable fact by key (overwrites)
//   recall   → read a previously remembered fact (or not-found)
// =============================================================================
import { tool } from "ai"
import { z } from "zod"
import type { SqlAgent } from "../db/db"
import { execSql } from "../db/db"

export function makeRememberTool(agent: SqlAgent) {
  return tool({
    description:
      "Persist a fact for future runs by key (overwrites). Use for salient, durable facts: 'priority_companies', 'focus_topic', 'blacklist', etc. Keep values short.",
    parameters: z.object({
      key: z.string().describe("Snake_case key, e.g. 'focus_topic'"),
      value: z.string().describe("The fact to remember"),
    }),
    execute: async ({ key, value }) => {
      execSql(
        agent,
        `INSERT INTO context (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
        [key, value, value],
      )
      return `Remembered ${key}.`
    },
  })
}

export function makeRecallTool(agent: SqlAgent) {
  return tool({
    description:
      "Retrieve a previously remembered fact by key. Returns the value or a not-found message.",
    parameters: z.object({ key: z.string() }),
    execute: async ({ key }) => {
      const rows = execSql(agent, `SELECT value FROM context WHERE key = ?`, [
        key,
      ])
      return rows.length > 0
        ? (rows[0].value as string)
        : `No memory for key: ${key}`
    },
  })
}

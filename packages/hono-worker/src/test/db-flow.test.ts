import { describe, it, expect } from "vitest"
import { execSql } from "../db/db"
import type { SqlAgent, SqlRow, SqlValue } from "../db/db"

/**
 * Round-trip / flow tests for execSql against a (minimal) in-memory SQL agent.
 *
 * Why this exists: the user reported that "creation works, but reading from it
 * does not" — i.e. INSERTs appeared to succeed while SELECTs threw
 *   "TypeError: Cannot read properties of undefined (reading 'ctx')".
 * That was caused by execSql receiving a DETACHED this.sql reference. These
 * tests run the SAME execSql that the agents use, through a mock agent that
 * reads/writes a real backing store, to prove writes are readable.
 *
 * The mock agent implements just enough of the SDK sql() contract (tagged
 * template + this.ctx.storage.sql.exec) to exercise the full code path:
 *   execSql(agent, query, params) -> agent.sql(strings, ...values)
 *                                  -> this.ctx.storage.sql.exec(...)
 *
 * It supports CREATE TABLE, INSERT, SELECT (with WHERE/LIMIT on id =?), and
 * table scans — enough for the round-trip flows the dashboard depends on.
 */

interface Table {
  columns: string[]
  rows: Map<number, Record<string, SqlValue>>
  nextId: number
}

function createInMemorySqlAgent(): SqlAgent {
  const tables = new Map<string, Table>()

  // Parse a CREATE TABLE column list into column names.
  function parseColumns(inner: string): string[] {
    const cols = inner
      .split(",")
      .map(c => c.trim().split(/\s+/)[0])
      .filter(Boolean)
    return cols
  }

  // Resolve "col = ?" predicates against bound values.
  function applyWhere(
    table: Table,
    where: string,
    values: SqlValue[],
  ): Record<string, SqlValue>[] {
    if (!where.trim()) return [...table.rows.values()]
    // Match repeated "col = ?" joined by AND (we only need id = ? flows).
    const out: Record<string, SqlValue>[] = []
    const conds = where.split(/AND/i)
    let vi = 0
    const predicates: { col: string; val: SqlValue }[] = []
    for (const cond of conds) {
      const m = cond.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?/)
      if (m) predicates.push({ col: m[1], val: values[vi++] })
    }
    for (const row of table.rows.values()) {
      if (predicates.every(p => row[p.col] === p.val)) out.push(row)
    }
    return out
  }

  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...values: SqlValue[]) {
          const q = query.trim()

          // CREATE TABLE IF NOT EXISTS name ( cols... )
          let m = q.match(
            /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)/i,
          )
          if (m) {
            const [, name, inner] = m
            if (!tables.has(name)) {
              tables.set(name, {
                columns: parseColumns(inner),
                rows: new Map(),
                nextId: 1,
              })
            }
            return []
          }

          // INSERT INTO name (cols) VALUES (?, ?, ...)
          m = q.match(
            /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i,
          )
          if (m) {
            const [, name, colList] = m
            const table = tables.get(name)
            const cols = colList.split(",").map(c => c.trim())
            const tableCols = table?.columns ?? []
            const row: Record<string, SqlValue> = {}
            let vi = 0
            for (const c of cols) {
              // Map declared column → underlying storage column name.
              const realCol = tableCols.find(
                tc => tc.toLowerCase() === c.toLowerCase(),
              )
              row[realCol ?? c] = values[vi++] ?? null
            }
            if (table) {
              const id = table.nextId++
              row["id"] = id
              table.rows.set(id, row)
            }
            return []
          }

          // SELECT last_insert_rowid() as id
          m = q.match(/SELECT\s+last_insert_rowid\(\)\s+as\s+id/i)
          if (m) {
            return []
          }

          // SELECT * FROM name [WHERE ...] [ORDER BY ...] [LIMIT n]
          m = q.match(
            /SELECT\s+\*?\s*FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+.+?)?(?:\s+LIMIT\s+(\d+))?$/i,
          )
          if (m) {
            const [, name, where, limitStr] = m
            const table = tables.get(name)
            if (!table) return []
            const filtered = where
              ? applyWhere(table, where, values)
              : [...table.rows.values()]
            const limit = limitStr ? Number(limitStr) : filtered.length
            return filtered.slice(0, limit)
          }

          // SELECT col, value FROM name — return as-is
          m = q.match(
            /SELECT\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i,
          )
          if (m) {
            const [, cols, name] = m
            const table = tables.get(name)
            if (!table) return []
            const colList = cols.split(",").map(c => c.trim())
            return [...table.rows.values()].map(r => {
              const out: Record<string, SqlValue> = {}
              for (const c of colList) out[c] = r[c]
              return out
            })
          }

          // SELECT COUNT(*) as count FROM ...
          m = q.match(/SELECT\s+COUNT\(\*\)\s+as\s+count/i)
          if (m) {
            return [{ count: values.length }]
          }

          // UPDATE name SET ... WHERE id = ?
          m = q.match(
            /UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/i,
          )
          if (m) {
            const [, name, setClause] = m
            const table = tables.get(name)
            if (!table) return []
            const targetId = values[values.length - 1] as number
            const row = table.rows.get(targetId)
            if (row) {
              const assignments = setClause.split(/,/)
              let vi = 0
              for (const a of assignments) {
                const cm = a.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?/)
                if (cm) row[cm[1]] = values[vi++] ?? null
              }
            }
            return []
          }

          // DELETE FROM name WHERE id = ?
          m = q.match(
            /DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s+WHERE\s+id\s*=\s*\?/i,
          )
          if (m) {
            const [, name] = m
            const table = tables.get(name)
            if (table) table.rows.delete(values[0] as number)
            return []
          }

          // Default: unknown query → empty result (don't crash the flow).
          return []
        },
      },
    },
  }

  // sql() defined as a METHOD (not an arrow fn) so it depends on the call-time
  // `this`, exactly like the SDK getter. execSql must preserve that binding.
  const agent = {
    ctx,
    sql(strings: TemplateStringsArray, ...vals: SqlValue[]): SqlRow[] {
      if (!this.ctx) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'ctx')",
        )
      }
      const query = strings.reduce(
        (acc, str, i) => acc + str + (i < vals.length ? "?" : ""),
        "",
      )
      return this.ctx.storage.sql.exec(query, ...vals) as SqlRow[]
    },
  }

  return agent as unknown as SqlAgent
}

describe("execSql round-trip flow (read-after-write)", () => {
  it("inserts into schedules and reads them back", () => {
    const agent = createInMemorySqlAgent()

    // CREATE
    execSql(
      agent,
      `CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cron TEXT NOT NULL,
        focus TEXT DEFAULT 'all',
        enabled INTEGER DEFAULT 1,
        last_triggered_at TEXT
      )`,
    )

    // INSERT (the "creation works" path)
    execSql(agent, `INSERT INTO schedules (cron, focus) VALUES (?, ?)`, [
      "0 9 * * *",
      "all",
    ])
    execSql(agent, `INSERT INTO schedules (cron, focus) VALUES (?, ?)`, [
      "*/5 * * * *",
      "jobs",
    ])

    // SELECT (the "reading from it does not" path — previously crashed)
    const rows = execSql(agent, `SELECT * FROM schedules ORDER BY id`)

    expect(rows.length).toBe(2)
    expect(rows[0].cron).toBe("0 9 * * *")
    expect(rows[1].cron).toBe("*/5 * * * *")
  })

  it("writes config rows and reads them back as key/value pairs", () => {
    const agent = createInMemorySqlAgent()
    execSql(
      agent,
      `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    )
    execSql(
      agent,
      `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
      ["goal", "find a job", "find a job"],
    )

    const rows = execSql(agent, `SELECT key, value FROM config`)
    expect(rows.length).toBe(1)
    expect(rows[0].key).toBe("goal")
    expect(rows[0].value).toBe("find a job")
  })

  it("inserts a step_log row and selects it by run_id", () => {
    const agent = createInMemorySqlAgent()
    execSql(
      agent,
      `CREATE TABLE IF NOT EXISTS step_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        step_number INTEGER,
        action TEXT,
        input TEXT,
        output TEXT,
        agent TEXT
      )`,
    )
    execSql(
      agent,
      `INSERT INTO step_log (run_id, step_number, action, input, output, agent)
       VALUES (?, ?, ?, ?, ?, 'harness')`,
      ["run-1", 0, "think", null, "starting"],
    )

    const rows = execSql(agent, `SELECT * FROM step_log WHERE run_id = ?`, [
      "run-1",
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].run_id).toBe("run-1")
    expect(rows[0].action).toBe("think")
  })

  it("updates and deletes rows by id", () => {
    const agent = createInMemorySqlAgent()
    execSql(
      agent,
      `CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cron TEXT NOT NULL,
        focus TEXT,
        enabled INTEGER DEFAULT 1
      )`,
    )
    execSql(agent, `INSERT INTO schedules (cron, focus) VALUES (?, ?)`, [
      "0 9 * * *",
      "all",
    ])

    // UPDATE
    execSql(agent, `UPDATE schedules SET enabled = ? WHERE id = ?`, [0, 1])
    const afterUpdate = execSql(agent, `SELECT * FROM schedules ORDER BY id`)
    expect(afterUpdate[0].enabled).toBe(0)

    // DELETE
    execSql(agent, `DELETE FROM schedules WHERE id = ?`, [1])
    const afterDelete = execSql(agent, `SELECT * FROM schedules ORDER BY id`)
    expect(afterDelete.length).toBe(0)
  })
})

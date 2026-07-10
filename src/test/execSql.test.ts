import { describe, it, expect } from "vitest"
import { execSql } from "../db/db"
import type { SqlAgent, SqlValue } from "../db/db"

/**
 * Tests for the shared execSql helper (src/db.ts).
 *
 * It adapts a (query, params) call style to the Agents SDK's tagged-template
 * `sql` getter. Two failure modes it must NOT regress into:
 *
 *   1. LOST `this` — the SDK's sql() reads `this.ctx`, so calling a detached
 *      method throws "Cannot read properties of undefined (reading 'ctx')".
 *      execSql must therefore call `sql` AS A METHOD ON THE AGENT.
 *
 *   2. SINGLE-VALUE TEMPLATE — stuffing the whole query into one `${}` makes
 *      the SDK emit query "?" with the SQL bound as the first param, which
 *      SQLite rejects. execSql must emit one `${}` per placeholder.
 *
 * The mock agents below faithfully reproduce the SDK's sql() implementation:
 *   sql(strings, ...values) { ... this.ctx.storage.sql.exec(query, ...values) }
 * so we can assert both the `this` binding and the placeholder shape.
 */

// A stand-in for the SDK's `sql` getter. It mirrors EXACTLY how the real one
// reconstructs the query and reads `this.ctx`, so any binding/placeholder bug
// surfaces as the same error the real DO would produce.
function makeMockAgent(forceBindCheck = true) {
  let lastQuery: string | null = null
  let lastValues: SqlValue[] = []
  const storage = {
    sql: {
      exec(actualQuery: string, ...vals: SqlValue[]) {
        lastQuery = actualQuery
        lastValues = vals
        return []
      },
    },
  }
  const ctx = forceBindCheck ? { storage } : undefined

  const agent = {
    ctx,
    // Defined as a method (not arrow) so it relies on the call-time `this`,
    // exactly like the class getter in the SDK.
    sql(strings: TemplateStringsArray, ...values: SqlValue[]) {
      if (!this.ctx) {
        // Mirror the SDK's real crash so tests catch the lost-`this` bug.
        throw new TypeError(
          "Cannot read properties of undefined (reading 'ctx')",
        )
      }
      const query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        "",
      )
      return this.ctx.storage.sql.exec(query, ...values)
    },
  }
  return {
    agent,
    // observe what the underlying storage actually received
    observed: () => ({ query: lastQuery, values: [...lastValues] }),
    reset: () => {
      lastQuery = null
      lastValues = []
    },
  }
}

describe("execSql — placeholder binding", () => {
  it("emits one bound ? per placeholder and passes values positionally", () => {
    const { agent, observed } = makeMockAgent()
    execSql(agent as unknown as SqlAgent, "SELECT * FROM t WHERE id = ?", [42])

    const { query, values } = observed()
    // The reconstructed SQL must contain a literal "?" placeholder (NOT the
    // inlined value), and the value must be bound separately.
    expect(query).toBe("SELECT * FROM t WHERE id = ?")
    expect(values).toEqual([42])
  })

  it("binds multiple params in order", () => {
    const { agent, observed } = makeMockAgent()
    execSql(
      agent as unknown as SqlAgent,
      "SELECT * FROM t WHERE a = ? AND b = ?",
      ["foo", 123],
    )
    const { query, values } = observed()
    expect(query).toBe("SELECT * FROM t WHERE a = ? AND b = ?")
    expect(values).toEqual(["foo", 123])
  })

  it("runs parameterless queries unchanged", () => {
    const { agent, observed } = makeMockAgent()
    execSql(agent as unknown as SqlAgent, "SELECT * FROM t")
    const { query, values } = observed()
    expect(query).toBe("SELECT * FROM t")
    expect(values).toEqual([])
  })

  it("binds NULL for missing params instead of mangling the query", () => {
    const { agent, observed } = makeMockAgent()
    // 2 placeholders, only 1 param: the second must become NULL, and the query
    // must still have exactly two `?` (NOT collapse to a half-query).
    execSql(
      agent as unknown as SqlAgent,
      "SELECT * FROM t WHERE a = ? AND b = ?",
      ["foo"],
    )
    const { query, values } = observed()
    expect(query).toBe("SELECT * FROM t WHERE a = ? AND b = ?")
    expect(values).toEqual(["foo", null])
  })

  it("ignores extra params beyond the placeholder count", () => {
    const { agent, observed } = makeMockAgent()
    execSql(agent as unknown as SqlAgent, "SELECT * FROM t WHERE a = ?", [
      "foo",
      "bar",
      42,
    ])
    const { query, values } = observed()
    expect(query).toBe("SELECT * FROM t WHERE a = ?")
    expect(values).toEqual(["foo"])
  })

  it("preserves boolean and null params as bound values (not stringified)", () => {
    const { agent, observed } = makeMockAgent()
    execSql(
      agent as unknown as SqlAgent,
      "UPDATE t SET active = ?, name = ? WHERE id = ?",
      [true, null, 5],
    )
    const { query, values } = observed()
    expect(query).toBe("UPDATE t SET active = ?, name = ? WHERE id = ?")
    // Real typed values passed through untouched — no String(true)/"null".
    expect(values).toEqual([true, null, 5])
  })
})

describe("execSql — `this` binding regression (the production crash)", () => {
  it("does NOT throw 'reading ctx' because sql is called as an agent method", () => {
    const { agent } = makeMockAgent(true)
    // Before the fix, this call crashed with:
    //   "TypeError: Cannot read properties of undefined (reading 'ctx')"
    expect(() =>
      execSql(agent as unknown as SqlAgent, "SELECT 1", []),
    ).not.toThrow()
  })

  it("WILL throw if someone reintroduces the detached-method bug", () => {
    // Sanity check: a bare function reference (the old pattern) loses `this`.
    const { agent } = makeMockAgent(true)
    const detached = agent.sql // <-- the exact thing execSql avoids doing
    expect(() => detached`SELECT 1`).toThrow(
      /Cannot read properties of undefined \(reading 'ctx'\)/,
    )
  })
})

describe("execSql — no single-value template regression", () => {
  it("never sends the whole SQL as a single bound string", () => {
    const { agent, observed } = makeMockAgent()
    execSql(agent as unknown as SqlAgent, "INSERT INTO t (a) VALUES (?)", [
      "hello",
    ])
    const { query, values } = observed()
    // The trap we're guarding against: query === "?" and values === ["INSERT..."].
    expect(query).not.toBe("?")
    expect(query).toBe("INSERT INTO t (a) VALUES (?)")
    expect(values).toEqual(["hello"])
  })
})

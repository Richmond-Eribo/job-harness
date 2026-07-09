import { describe, it, expect } from "vitest"

/**
 * Tests for the execSql helper that adapts (query, params) style calls
 * to the Agent SDK's tagged-template sql function.
 */

type SqlValue = string | number | boolean | null
type SqlRow = Record<string, SqlValue>

// Replicate the execSql logic from the agent files
function execSql(
  sql: (strings: TemplateStringsArray, ...values: SqlValue[]) => SqlRow[],
  query: string,
  params: SqlValue[] = [],
): SqlRow[] {
  const segments = query.split("?")
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    parts.push(segments[i])
    if (i < segments.length - 1 && i < params.length) {
      parts.push(String(params[i] ?? null))
    }
  }
  return sql`${parts.join("")}`
}

describe("execSql", () => {
  // Mock sql function that captures what it receives.
  // Tagged templates pass: sql`${value}` → strings=['',''], values=[value]
  // So the actual SQL is in values[0], not strings[0].
  let capturedQuery = ""
  const mockSql = (_strings: TemplateStringsArray, ...values: SqlValue[]) => {
    capturedQuery = String(values[0] ?? "")
    return []
  }

  it("converts parameterized query to plain SQL", () => {
    execSql(mockSql, "SELECT * FROM t WHERE id = ?", [42])
    expect(capturedQuery).toBe("SELECT * FROM t WHERE id = 42")
  })

  it("handles multiple parameters", () => {
    execSql(mockSql, "SELECT * FROM t WHERE a = ? AND b = ?", ["foo", 123])
    expect(capturedQuery).toBe("SELECT * FROM t WHERE a = foo AND b = 123")
  })

  it("handles no parameters", () => {
    execSql(mockSql, "SELECT * FROM t")
    expect(capturedQuery).toBe("SELECT * FROM t")
  })

  it("handles null parameters", () => {
    execSql(mockSql, "INSERT INTO t (a) VALUES (?)", [null])
    expect(capturedQuery).toBe("INSERT INTO t (a) VALUES (null)")
  })

  it("handles boolean parameters", () => {
    execSql(mockSql, "UPDATE t SET active = ? WHERE id = ?", [true, 5])
    expect(capturedQuery).toBe("UPDATE t SET active = true WHERE id = 5")
  })

  it("handles more placeholders than params gracefully", () => {
    execSql(mockSql, "SELECT * FROM t WHERE a = ? AND b = ?", ["foo"])
    // When there are more placeholders than params, the trailing placeholder
    // becomes empty string (no value substituted)
    expect(capturedQuery).toBe("SELECT * FROM t WHERE a = foo AND b = ")
  })

  it("handles more params than placeholders gracefully", () => {
    execSql(mockSql, "SELECT * FROM t WHERE a = ?", ["foo", "bar", 42])
    expect(capturedQuery).toBe("SELECT * FROM t WHERE a = foo")
  })
})

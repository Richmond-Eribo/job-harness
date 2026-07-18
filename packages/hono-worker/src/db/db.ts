// =============================================================================
// Shared DB helpers for the Agents SDK SQLite API
// =============================================================================
// IMPORTANT: The Cloudflare `Agent` SDK exposes `sql` as a *tagged template*
// getter defined on the Agent class:
//
//     sql(strings, ...values) {
//       return [...this.ctx.storage.sql.exec(query, ...values)]
//     }                       ^^^^^^^^  <-- needs `this` (the Agent)
//
// Two subtle bugs that this module exists to prevent:
//
//   1. LOST `this` BINDING. Passing `this.sql` as a bare function reference
//      detaches it from the Agent instance. When the helper later invokes it,
//      `this` is `undefined`, so `this.ctx` throws:
//        "failed to execute sql query: ?  TypeError: Cannot read properties of
//         undefined (reading 'ctx')"
//      → FIX: pass the Agent instance; call `agent.sql(...)` so `this` is
//        preserved by the method call.
//
//   2. BOUND PARAMETERS, NOT INLINED LITERALS. The SDK turns EACH `${value}`
//      interpolation into one bound `?` placeholder. Stuffing the whole query
//      into a single `${}` (e.g. `sql\`${entireQuery}\``) produces the query
//      "?" with the whole SQL string bound as one param — which SQLite rejects.
//      → FIX: split the query on the text placeholder `?` so each original
//        `?` maps to exactly one `${value}` and one bound parameter.
// =============================================================================

export type SqlValue = string | number | boolean | null
export type SqlRow = Record<string, SqlValue>

/**
 * Minimal interface for anything that exposes the Agents SDK `sql` tagged
 * template (i.e. an `Agent` instance). Narrowing to this keeps the helper
 * decoupled from the concrete Agent base class.
 */
export interface SqlAgent {
  sql: (strings: TemplateStringsArray, ...values: SqlValue[]) => SqlRow[]
}

/**
 * Execute a `?`-parameterised SQL string against an Agent's SQLite storage.
 *
 * @example
 *   execSql(this, `SELECT * FROM t WHERE id = ?`, [42])
 *
 * This is functionally identical to writing the tagged template by hand:
 *
 *   this.sql`SELECT * FROM t WHERE id = ${42}`
 *
 * Each `?` in `query` becomes exactly one bound parameter (matched positionally
 * to `params`). If `params` is shorter than the number of `?` placeholders,
 * the missing ones are bound as `NULL` (rather than producing a malformed half
 * query). Extra params beyond the placeholder count are ignored.
 */
export function execSql(
  agent: SqlAgent,
  query: string,
  params: SqlValue[] = [],
): SqlRow[] {
  // Split on the literal `?` so each placeholder lines up with one bound value.
  // For N placeholders we get N+1 segments.
  const segments = query.split("?")
  const placeholderCount = segments.length - 1

  // Tagged templates are invoked as:  tag(strings, ...values)
  // where `strings` is a TemplateStringsArray. The reconstructed query must
  // interleave segments with `?` so the SDK emits one bound `?` per value.
  const strings = segments as unknown as TemplateStringsArray
  // The Agents SDK only reads indexed elements of `strings` (via reduce), but
  // we attach `.raw` so the value is a well-formed TemplateStringsArray.
  ;(strings as unknown as { raw: readonly string[] }).raw = segments

  const values: SqlValue[] = []
  for (let i = 0; i < placeholderCount; i++) {
    values.push(i < params.length ? params[i] : null)
  }

  // Call `sql` AS A METHOD on the agent — this preserves the `this` binding
  // that the SDK relies on to reach `this.ctx.storage.sql`.
  return agent.sql(strings, ...values)
}

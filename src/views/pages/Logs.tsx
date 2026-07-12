// Logs page — server-rendered flat request log. Each row is clickable; the
// Sheet shows full input / output / reasoning for that step. Rows are real
// HTML so the page is searchable by the browser's Ctrl+F and accessible to
// screen readers.
import type { FC } from "hono/jsx"

const actionLevel = (action: string): string => {
  if (!action) return "info"
  if (/error/i.test(action)) return "error"
  if (/warn/i.test(action)) return "warn"
  if (action === "finish" || action === "done") return "ok"
  if (/idle|loop|interrupt/i.test(action)) return "warn"
  return "info"
}

export const LogsPage: FC<{ log: any[] }> = ({ log }) => {
  const esc = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  return (
    <section class="page" id="page-logs">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Logs</div>
            <div class="card-sub">
              flat request log — every model request, tool call, KV write, and
              error the harness observed. one line each.
            </div>
          </div>
          <a class="btn sm ghost" href="/logs" aria-label="Refresh logs">↻ Refresh</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Run</th>
              <th>Step</th>
              <th>Level</th>
              <th>Source</th>
              <th>Action</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody id="log-body">
            {!log || log.length === 0 ? (
              <tr>
                <td colspan={7} class="empty">
                  No activity yet.
                </td>
              </tr>
            ) : (
              log.map(l => {
                const lvl = actionLevel(l.action)
                // click → open detail in Sheet. Each row also carries the full
                // entry as data-* so the Sheet renderer can pull it without a
                // round-trip.
                const dataAttrs = `data-entry='${esc(JSON.stringify(l))}'`
                return (
                  <tr
                    class="log-row"
                    onclick={`onLogRowClick(${esc(JSON.stringify(l))})`}
                  >
                    <td>{new Date(l.createdAt).toLocaleTimeString()}</td>
                    <td class="log-row-cell mono">
                      <code>{esc((l.runId || "").slice(0, 12))}</code>
                    </td>
                    <td>{l.stepNumber ?? "—"}</td>
                    <td class="log-row-cell">
                      <span class={`lvl lvl-${lvl}`}>{lvl.toUpperCase()}</span>
                    </td>
                    <td class="log-row-cell mono">{esc(l.agent || "harness")}</td>
                    <td class="action">{esc(l.action)}</td>
                    <td>{l.tokensUsed != null ? Number(l.tokensUsed).toLocaleString() : "—"}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default LogsPage

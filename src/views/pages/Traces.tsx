// Traces page — server-rendered table of runs. Clicking a row opens the Sheet
// with the hierarchical span tree (the heavy content — `run_start → system →
// prompt → reasoning → text → tool_call → tool_result → step_end`).
//
// The row click is a real link to `/traces/:runId` (so Cmd-click opens it in
// a new tab, the back button returns to the list). The Sheet is the JS
// enhancement for single-tab navigation.
import type { FC } from "hono/jsx"

export const TracesPage: FC<{ runs: any[] }> = ({ runs }) => {
  const esc = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  return (
    <section class="page" id="page-traces">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Traces</div>
            <div class="card-sub">
              each row is one end-to-end run. click to expand into the span
              tree: prompt → model turn → tool calls → results.
            </div>
          </div>
          <a class="btn sm ghost" href="/traces" aria-label="Refresh traces">↻ Refresh</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Run</th>
              <th>Steps</th>
              <th>Tokens</th>
              <th />
            </tr>
          </thead>
          <tbody id="runs-table-body">
            {!runs || runs.length === 0 ? (
              <tr>
                <td colspan={5} class="empty">
                  No traces yet. Start a run from the topbar.
                </td>
              </tr>
            ) : (
              runs.map(r => (
                <tr onclick={`openTraceSheet('${esc(r.runId)}')`}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <code>{esc(r.runId.slice(0, 14))}</code>
                  </td>
                  <td>{r.steps ?? 0}</td>
                  <td>{r.tokens != null ? Number(r.tokens).toLocaleString() : "—"}</td>
                  <td>
                    <span class="link">Open →</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default TracesPage

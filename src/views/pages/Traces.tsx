// Traces page — server-rendered table of runs. Each row is a real <a> link to
// /traces/:runId (so Cmd-click opens the transcript in a new tab and the back
// button returns here). The columns carry the v2 run metadata: status, goal,
// steps, and rolled-up tokens. The transcript itself lives on the run page.
import type { FC } from "hono/jsx"

const esc = (s: any) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const STATUS_LABEL: Record<string, string> = {
  max_steps_reached: "max steps",
  token_budget_reached: "budget",
  idle_detected: "idle",
  repeated_loop_detected: "loop",
  interrupted: "interrupted",
}

export const TracesPage: FC<{ runs: any[] }> = ({ runs }) => {
  return (
    <section class="page" id="page-traces">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Traces</div>
            <div class="card-sub">
              each row is one end-to-end run. click to open the step-by-step
              transcript: prompt → reasoning → tool calls → results, with
              sub-agent activity nested under each delegating call.
            </div>
          </div>
          <a class="btn sm ghost" href="/traces" aria-label="Refresh traces">
            ↻ Refresh
          </a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Run</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Tokens</th>
              <th>Goal</th>
              <th />
            </tr>
          </thead>
          <tbody id="runs-table-body">
            {!runs || runs.length === 0 ? (
              <tr>
                <td colspan={7} class="empty">
                  No traces yet. Start a run from the topbar.
                </td>
              </tr>
            ) : (
              runs.map(r => {
                const status = r.status
                  ? STATUS_LABEL[r.status] ?? r.status
                  : "—"
                return (
                  <tr
                    class="tr-link"
                    data-run-id={esc(r.runId)}
                    data-href={`/traces/${esc(r.runId)}`}
                  >
                    {/* row click is wired by a delegated handler in
                        dashboard.js so it uses SPA navigation when available */}
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      <code>{esc(r.runId.slice(0, 14))}</code>
                    </td>
                    <td>
                      <span class="chip chip-neutral">{esc(status)}</span>
                    </td>
                    <td>{r.steps ?? 0}</td>
                    <td>
                      {r.tokens != null
                        ? Number(r.tokens).toLocaleString()
                        : "—"}
                    </td>
                    <td class="ts-goal-cell">
                      {r.goal ? esc(r.goal.slice(0, 80)) : "—"}
                    </td>
                    <td>
                      <span class="link">Open →</span>
                    </td>
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

export default TracesPage

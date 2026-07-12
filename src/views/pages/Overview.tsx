// Overview page — server-rendered with status + token trend + recent runs +
// recent trace events. Client JS still hydrates the live-activity stream and
// the bar chart from JSON (those change every few seconds), but the initial
// paint is real HTML so the operator sees something immediately.
import type { FC } from "hono/jsx"
import { ICONS } from "../Layout"

const StatCard: FC<{
  label: string
  id?: string
  value: string
  sub?: string
  subId?: string
}> = ({ label, id, value, sub, subId }) => (
  <div class="stat-card">
    <div class="stat-top">
      <span class="stat-label">{label}</span>
      <span class="stat-badge" />
    </div>
    <div class="stat-value">
      <span id={id}>{value}</span>
    </div>
    {sub ? (
      <div class="stat-sub" id={subId ?? "_x"}>
        {sub}
      </div>
    ) : null}
  </div>
)

// Bar chart built from the server-loaded tokensByDay. Renders a real SSR
// <svg>; the client's renderBars() will refresh it as new data arrives.
const BarsChart: FC<{
  rows: Array<{
    day: string
    inTokens: number
    outTokens: number
    reasoningTokens: number
  }>
}> = ({ rows }) => {
  if (!rows || rows.length === 0) {
    return (
      <div id="bars-chart" class="bars-empty">
        No token data yet.
      </div>
    )
  }
  const max = Math.max(
    1,
    ...rows.map(
      r => (r.inTokens || 0) + (r.outTokens || 0) + (r.reasoningTokens || 0),
    ),
  )
  const today = new Date().toISOString().slice(0, 10)
  const fmtDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`
  return (
    <>
      <div id="bars-chart" class="bars">
        {rows.map(r => {
          const tot =
            (r.inTokens || 0) + (r.outTokens || 0) + (r.reasoningTokens || 0)
          const hPct = (tot / max) * 100
          // Percentage of total per component. We render them as stacked
          // div columns (CSS .seg-* classes), not <rect>s, so the existing
          // CSS keeps working without changes.
          const pct = (n: number) => (tot > 0 ? (n / tot) * 100 : 0)
          return (
            <div
              class={"bar-col" + (r.day === today ? " today" : "")}
              title={`${r.day}: ${tot.toLocaleString()} tokens`}
            >
              <div class="bar-stack" style={`height:${hPct}%`}>
                <div class="seg-in" style={`height:${pct(r.inTokens || 0)}%`} />
                <div class="seg-out" style={`height:${pct(r.outTokens || 0)}%`} />
                <div
                  class="seg-reasoning"
                  style={`height:${pct(r.reasoningTokens || 0)}%`}
                />
              </div>
              <div class="bar-x">{fmtDay(r.day)}</div>
            </div>
          )
        })}
      </div>
      <div class="bars-axis" id="bars-axis" />
    </>
  )
}

export const OverviewPage: FC<{
  status: any
  turns: any
  tokensByDay: any[]
  summaries: any[]
}> = ({ status, turns, tokensByDay, summaries }) => {
  const lastRunSub = status?.lastRunAt
    ? "Last run " +
      new Date(status.lastRunAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "No runs yet"
  const turnValue = turns?.lastTurn != null
    ? Number(turns.lastTurn).toLocaleString()
    : "—"
  const turnSub = turns?.lastTurn != null
    ? [
        turns.maxTurn != null ? "max " + Number(turns.maxTurn).toLocaleString() : null,
        turns.meanTurn != null ? "avg " + Number(turns.meanTurn).toLocaleString() : null,
        (turns.turns ?? 0) + ((turns.turns ?? 0) === 1 ? " turn" : " turns"),
      ]
        .filter(Boolean)
        .join(" · ")
    : "no turns yet"

  return (
    <section class="page" id="page-overview">
      <section class="stat-row">
        <StatCard
          label="Goal status"
          id="stat-goal-status"
          value={status?.status ?? "idle"}
          sub={lastRunSub}
          subId="stat-last-run"
        />
        <StatCard
          label="Output tokens / turn"
          id="stat-output-turn"
          value={turnValue}
          sub={turnSub}
          subId="stat-output-turn-sub"
        />
        <StatCard
          label="Steps"
          id="stat-step"
          value={String(status?.currentStep ?? 0)}
          sub={"of " + (status?.maxSteps ?? 100)}
          subId="stat-max"
        />
        <StatCard
          label="Jobs in pipeline"
          id="stat-jobs"
          value="—"
          sub="active cards"
        />
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Token spend per day</div>
            <div class="card-sub">
              output tokens per day, stacked with prompt + reasoning
            </div>
          </div>
          <div class="legend">
            <span class="leg"><i class="dot dot-in" />Prompt</span>
            <span class="leg"><i class="dot dot-out" />Output</span>
            <span class="leg"><i class="dot dot-r" />Reasoning</span>
          </div>
        </div>
        <BarsChart rows={tokensByDay} />
      </section>

      <section class="row-eq-2">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Recent runs</div>
              <div class="card-sub">last run summaries</div>
            </div>
            <a class="link" href="/traces">View all</a>
          </div>
          <div id="summaries-list" class="scroll-list">
            {summaries && summaries.length > 0 ? (
              // The detailed summary rendering stays in JS for now (chips +
              // markdown parsing). Server renders a placeholder + the client
              // hydrates on init.
              <div class="empty">Loading recent runs…</div>
            ) : (
              <div class="empty">No runs yet.</div>
            )}
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Live activity</div>
              <div class="card-sub">
                <span id="run-id-label">
                  {status?.status === "running" && status?.runId
                    ? status.runId.slice(0, 16)
                    : (status?.status ?? "idle") + " — no active run"}
                </span>
              </div>
            </div>
            <a class="link" href="/logs">View all</a>
          </div>
          <div id="live-events" class="scroll-list">
            <div class="empty">Start a run to see live activity.</div>
          </div>
        </div>
      </section>
    </section>
  )
}

export default OverviewPage

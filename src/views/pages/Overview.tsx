// Overview page — JOB-FIRST.
// =============================================================================
// This agent's whole purpose is finding jobs and making it easy to add them.
// So the overview leads with the pipeline: a big total + per-stage breakdown,
// an inline "add a job" form (the fastest path to capture something you just
// heard about), and your top matches. Agent status + token trend are demoted
// to the bottom — still visible, no longer dominating.
//
// Server-rendered for first paint; the live-activity stream + bar chart are
// hydrated by JS. Adding a job posts to POST /api/jobs and refreshes counts
// in place (see dashboard.js submitOverviewJob).
// =============================================================================
import type { FC } from "hono/jsx"
import { ICONS } from "../Layout"

const esc = (s: any) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

// Pipeline stages in order. Colors match the Jobs Kanban headers so the two
// pages read as one system. `rejected` is tracked in the data but not shown as
// a headline stage (it's a terminal outcome, not active pipeline).
const STAGES = [
  { key: "discovered", label: "Discovered", color: "var(--text-3)" },
  { key: "draft", label: "Draft", color: "var(--warn)" },
  { key: "applied", label: "Applied", color: "var(--amber)" },
  { key: "interview", label: "Interview", color: "#a78bfa" },
  { key: "offer", label: "Offer", color: "var(--ok)" },
] as const

// ── Stat card (reused for the headline metrics) ────────────────────────────
const StatCard: FC<{
  label: string
  value: string
  sub?: string
  accent?: string
  id?: string
}> = ({ label, value, sub, accent, id }) => (
  <div class="stat-card ov-stat-card">
    <div class="stat-top">
      <span class="stat-label">{label}</span>
    </div>
    <div class="stat-value" style={accent ? `color:${accent}` : undefined}>
      <span id={id}>{value}</span>
    </div>
    {sub ? <div class="stat-sub">{sub}</div> : null}
  </div>
)

export const OverviewPage: FC<{
  status: any
  turns: any
  tokensByDay: any[]
  summaries: any[]
  pipeline: { listings: any[]; stats: any }
  followUps: any[]
}> = ({ status, turns, tokensByDay, summaries, pipeline, followUps }) => {
  const stats = pipeline?.stats ?? { total: 0, byStatus: {}, dueFollowUps: 0 }
  const listings = pipeline?.listings ?? []
  const total = stats.total ?? listings.length ?? 0
  const byStatus = stats.byStatus ?? {}

  // Active pipeline = everything except rejected.
  const activeCount = STAGES.reduce(
    (sum, s) => sum + (Number(byStatus[s.key]) || 0),
    0,
  )

  // Top matches: highest matchScore among discovered/draft, capped at 6.
  const topMatches = listings
    .filter(
      j =>
        (j.status === "discovered" || j.status === "draft") &&
        j.matchScore != null,
    )
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, 6)

  // Is the agent actively running? Drives the live banner.
  const running = status?.status === "running"

  return (
    <section class="page" id="page-overview">
      {/* ── Headline metric cards ─────────────────────────────────────────── */}
      <section class="stat-row">
        <StatCard
          label="Jobs in pipeline"
          value={String(total)}
          sub={`${activeCount} active · ${Number(byStatus.rejected) || 0} rejected`}
          accent="var(--amber)"
          id="ov-total"
        />
        <StatCard
          label="Due follow-ups"
          value={String(stats.dueFollowUps ?? 0)}
          sub={stats.dueFollowUps ? "needs attention" : "nothing due"}
          accent={stats.dueFollowUps ? "var(--danger)" : undefined}
          id="ov-followups"
        />
        <StatCard
          label="Agent status"
          value={status?.status ?? "idle"}
          sub={
            status?.lastRunAt
              ? "last run " +
                new Date(status.lastRunAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "no runs yet"
          }
          accent={running ? "var(--amber)" : undefined}
          id="ov-status"
        />
      </section>

      {/* ── Stage breakdown bar ───────────────────────────────────────────── */}
      <section class="card ov-stages-card">
        <div class="card-head">
          <div>
            <div class="card-title">Pipeline by stage</div>
            <div class="card-sub">where your {total} jobs sit right now</div>
          </div>
          <a class="btn sm ghost" href="/jobs">
            Open board →
          </a>
        </div>
        <div class="ov-stages" id="ov-stages">
          {STAGES.map(s => {
            const count = Number(byStatus[s.key]) || 0
            const pct = total > 0 ? (count / total) * 100 : 0
            return (
              <a class="ov-stage" href={`/jobs#${s.key}`} style={`--stage:${s.color}`}>
                <div class="ov-stage-bar">
                  <div class="ov-stage-fill" style={`width:${pct}%`} />
                </div>
                <div class="ov-stage-label">
                  <span class="ov-stage-name">{s.label}</span>
                  <span class="ov-stage-count">{count}</span>
                </div>
              </a>
            )
          })}
        </div>
      </section>

      {/* ── Inline add-job + top matches (two columns) ────────────────────── */}
      <section class="row-eq-2">
        {/* Inline add-job form — the fast path to capture a lead. */}
        <div class="card ov-add-card">
          <div class="card-head">
            <div>
              <div class="card-title">Add a job</div>
              <div class="card-sub">
                heard about a role? drop it here — it lands in Discovered.
              </div>
            </div>
          </div>
          <form
            class="ov-add-form"
            id="ov-add-form"
            onsubmit="event.preventDefault();submitOverviewJob()"
          >
            <div class="ov-field">
              <label for="ov-company">Company</label>
              <input
                id="ov-company"
                name="company"
                type="text"
                placeholder="e.g. Anthropic"
                required
              />
            </div>
            <div class="ov-field">
              <label for="ov-title">Title</label>
              <input
                id="ov-title"
                name="title"
                type="text"
                placeholder="e.g. Senior TypeScript Engineer"
                required
              />
            </div>
            <div class="ov-field">
              <label for="ov-url">URL (optional)</label>
              <input
                id="ov-url"
                name="url"
                type="url"
                placeholder="https://…"
              />
            </div>
            <div class="ov-field ov-field-grow">
              <label for="ov-desc">Notes (optional)</label>
              <textarea
                id="ov-desc"
                name="description"
                rows={3}
                placeholder="recruiter name, salary hint, why it's interesting…"
              />
            </div>
            <button type="submit" class="btn primary ov-add-btn">
              <span dangerouslySetInnerHTML={{ __html: ICONS.plus }} />
              Add to pipeline
            </button>
            <div class="ov-add-msg" id="ov-add-msg" />
          </form>
        </div>

        {/* Top matches — the highest-fit jobs to act on next. */}
        <div class="card ov-matches-card">
          <div class="card-head">
            <div>
              <div class="card-title">Top matches</div>
              <div class="card-sub">highest fit-score, ready to action</div>
            </div>
          </div>
          <div class="ov-matches" id="ov-matches">
            {topMatches.length === 0 ? (
              <div class="empty">
                No scored matches yet. Start a discovery run or add a job
                manually.
              </div>
            ) : (
              topMatches.map(j => {
                const pct =
                  j.matchScore != null ? Math.round(j.matchScore * 100) : null
                return (
                  <a
                    class="ov-match"
                    href={`/jobs/${j.id}`}
                    onclick={`event.preventDefault();openJobSheet(${j.id})`}
                    data-job-id={j.id}
                  >
                    <div class="ov-match-head">
                      <span class="ov-match-company">{esc(j.company)}</span>
                      {pct != null ? (
                        <span class="ov-match-score" data-pct={pct}>
                          {pct}%
                        </span>
                      ) : null}
                    </div>
                    <div class="ov-match-title">{esc(j.title)}</div>
                  </a>
                )
              })
            )}
          </div>
        </div>
      </section>

      {/* ── Due follow-ups (only if there are any) ────────────────────────── */}
      {followUps && followUps.length > 0 ? (
        <section class="card ov-followups-card">
          <div class="card-head">
            <div>
              <div class="card-title">Due follow-ups</div>
              <div class="card-sub">
                {followUps.length} overdue — chase these now
              </div>
            </div>
          </div>
          <div class="ov-followups">
            {followUps.slice(0, 8).map(f => (
              <a class="ov-followup" href={`/jobs/${f.jobId}`}>
                <span class="ov-fu-date">{esc(f.dueDate)}</span>
                <span class="ov-fu-note">{esc(f.note || "(no note)")}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Demoted: agent status + token trend ──────────────────────────── */}
      <section class="row-eq-2 ov-bottom">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Recent runs</div>
              <div class="card-sub">last run summaries</div>
            </div>
            <a class="link" href="/traces">
              View all
            </a>
          </div>
          <div id="summaries-list" class="scroll-list">
            {summaries && summaries.length > 0 ? (
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
                  {running && status?.runId
                    ? status.runId.slice(0, 16)
                    : (status?.status ?? "idle") + " — no active run"}
                </span>
              </div>
            </div>
            <a class="link" href="/logs">
              View all
            </a>
          </div>
          <div id="live-events" class="scroll-list">
            <div class="empty">Start a run to see live activity.</div>
          </div>
        </div>
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
            <span class="leg">
              <i class="dot dot-in" />
              Prompt
            </span>
            <span class="leg">
              <i class="dot dot-out" />
              Output
            </span>
            <span class="leg">
              <i class="dot dot-r" />
              Reasoning
            </span>
          </div>
        </div>
        <BarsChart rows={tokensByDay} />
      </section>
    </section>
  )
}

// Bar chart — kept as-is (now at the bottom of the page). SSR <svg>; the
// client's renderBars() refreshes it as new data arrives.
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

export default OverviewPage

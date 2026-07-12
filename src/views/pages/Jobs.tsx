// Jobs page — server-rendered Kanban board. The Kanban cards are real HTML
// anchors (`<a href="/jobs/:id">`) so Cmd-click opens the job detail in a new
// tab. Clicking without modifier opens the Sheet (progressive enhancement:
// the sheet is faster, but the link works without JS too).
import type { FC } from "hono/jsx"
import { ICONS } from "../Layout"

const PIPELINE_COLUMNS = [
  { key: "discovered", label: "Discovered", color: "var(--ink-3)" },
  { key: "draft", label: "Draft", color: "var(--warn)" },
  { key: "applied", label: "Applied", color: "var(--accent)" },
  { key: "interview", label: "Interview", color: "#a78bfa" },
  { key: "offer", label: "Offer", color: "var(--ok)" },
  { key: "rejected", label: "Rejected", color: "var(--danger)" },
]

export const JobsPage: FC<{
  listings: any[]
  stats: any
}> = ({ listings, stats }) => {
  return (
    <section class="page" id="page-jobs">
      <div class="logs-toolbar">
        <button class="btn sm ghost" onclick="showModal('job-modal')">
          <span dangerouslySetInnerHTML={{ __html: ICONS.plus }} />
          Add job
        </button>
        <button class="btn sm ghost" onclick="showModal('profile-modal')">Profile</button>
        <button class="btn sm primary" onclick="startRun()">Start discovery run</button>
      </div>
      <div class="kanban-scroll">
        <div class="kanban-board" id="kanban-board">
          {PIPELINE_COLUMNS.map(col => {
            const jobs = (listings || []).filter(j => j.status === col.key)
            return (
              <div class="kanban-column" data-status={col.key}>
                <div class="kanban-header" style={`color:${col.color}`}>
                  <span>{col.label.toUpperCase()}</span>
                  <span class="kanban-count">{jobs.length}</span>
                </div>
                <div class="kanban-cards">
                  {jobs.length === 0 ? (
                    <div class="kanban-empty">Empty</div>
                  ) : (
                    jobs.map(j => {
                      // escape text — the listings are real data, not trusted.
                      const esc = (s: string) =>
                        String(s ?? "")
                          .replace(/&/g, "&amp;")
                          .replace(/</g, "&lt;")
                          .replace(/>/g, "&gt;")
                          .replace(/"/g, "&quot;")
                      return (
                        <a
                          href={`/jobs/${j.id}`}
                          class="kanban-card"
                          // JS intercepts the click to open the Sheet in-page;
                          // without JS it just navigates to /jobs/:id.
                          onclick={`event.preventDefault();openJobSheet(${j.id})`}
                        >
                          <div
                            class="company"
                            dangerouslySetInnerHTML={{ __html: esc(j.company) }}
                          />
                          <div
                            class="title"
                            dangerouslySetInnerHTML={{ __html: esc(j.title) }}
                          />
                          <div class="match">
                            {j.matchScore != null ? (
                              <span class="badge-score">
                                {Math.round(j.matchScore * 100)}%
                              </span>
                            ) : null}
                            <span class="badge-src">
                              {j.source === "auto-discovered" ? "AUTO" : "MANUAL"}
                            </span>
                          </div>
                        </a>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default JobsPage

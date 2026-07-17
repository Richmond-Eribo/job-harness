// Jobs page — server-rendered Kanban board. The Kanban cards expose an anchor
// link (`href="/jobs/:id"`) so Cmd-click opens the job detail in a new tab
// and a no-JS click still navigates. A plain left-click is intercepted by
// `openJobSheet()` to open the in-page Sheet instead (progressive enhancement:
// the sheet is faster, but the route always exists too).
//
// Layout mirrors the reference Kanban: five lateral columns of a fixed width
// that scroll horizontally, each column header tinted with its accent color,
// and cards that expose a delete button on hover.
import type { FC } from "hono/jsx"
import { ICONS } from "../Layout"

// Same five columns as the reference board. `rejected` is a valid status in
// the data model but intentionally NOT shown as a column here — like the
// reference, those rows are kept off the board. Each accent is one of the
// dashboard's existing token colors so the headers read as part of the same
// system rather than a separate palette.
const PIPELINE_COLUMNS = [
  { key: "discovered", label: "Discovered", accent: "var(--text-3)" },
  { key: "draft", label: "Draft", accent: "var(--warn)" },
  { key: "applied", label: "Applied", accent: "var(--amber)" },
  { key: "interview", label: "Interview", accent: "#a78bfa" },
  { key: "offer", label: "Offer", accent: "var(--ok)" },
]

export const JobsPage: FC<{
  listings: any[]
  stats: any
}> = ({ listings, stats }) => {
  // escape text — the listings are real data, not trusted.
  const esc = (s: string) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")

  return (
    <section class="page" id="page-jobs">
      <div class="logs-toolbar">
        <button class="btn sm ghost" onclick="showModal('job-modal')">
          <span dangerouslySetInnerHTML={{ __html: ICONS.plus }} />
          Add job
        </button>
        <button class="btn sm ghost" onclick="showModal('sources-modal')">
          Sources
        </button>
        <button class="btn sm ghost" onclick="showModal('profile-modal')">
          Profile
        </button>
        <button class="btn sm primary" onclick="startRun()">
          <span dangerouslySetInnerHTML={{ __html: ICONS.sparkles }} />
          Start discovery run
        </button>
      </div>

      <div class="kanban-scroll">
        <div class="kanban-board" id="kanban-board">
          {PIPELINE_COLUMNS.map(col => {
            const jobs = (listings || []).filter(j => j.status === col.key)
            return (
              <section class="kanban-column" data-status={col.key}>
                <div class="kanban-header">
                  <span class="kanban-title" style={`color:${col.accent}`}>
                    {col.label.toUpperCase()}
                  </span>
                  <span class="kanban-count">{jobs.length}</span>
                </div>

                <div class="kanban-cards">
                  {jobs.length === 0 ? (
                    <p class="kanban-empty">Empty</p>
                  ) : (
                    jobs.map(j => {
                      // matchScore is stored 0..1; show as integer percent.
                      const autoPct =
                        j.matchScore != null
                          ? Math.round(j.matchScore * 100)
                          : null
                      return (
                        <article
                          class="kanban-card"
                          data-job-id={j.id}
                          // drag handled by wireKanbanDnD in dashboard.js
                          draggable="true"
                        >
                          {/* The whole card body is a link so Cmd-click and
                              no-JS both navigate; JS intercepts a plain
                              click to open the in-page Sheet instead. */}
                          <a
                            class="kanban-card-link"
                            href={`/jobs/${j.id}`}
                            onclick={`event.preventDefault();openJobSheet(${j.id})`}
                          >
                            <span
                              class="kanban-company"
                              dangerouslySetInnerHTML={{
                                __html: esc(j.company),
                              }}
                            />
                            <span
                              class="kanban-role"
                              dangerouslySetInnerHTML={{
                                __html: esc(j.title),
                              }}
                            />
                            <span class="kanban-match">
                              {autoPct != null ? (
                                <span class="kanban-auto">
                                  {autoPct}% AUTO
                                </span>
                              ) : (
                                <span class="kanban-auto kanban-auto-manual">
                                  MANUAL
                                </span>
                              )}
                            </span>
                          </a>

                          {/* Hover-only delete — a button, not a link, so it
                              never navigates. Wired to removeJob() in
                              dashboard.js. */}
                          <button
                            type="button"
                            class="kanban-delete"
                            aria-label={`Delete ${j.company} ${j.title}`}
                            onclick={`event.preventDefault();event.stopPropagation();removeJob(${j.id})`}
                            dangerouslySetInnerHTML={{ __html: ICONS.trash }}
                          />
                        </article>
                      )
                    })
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default JobsPage

// =============================================================================
// Dashboard — sidebar two-panel admin layout (v3 redesign).
// =============================================================================
// Layout (per redesign spec):
//   ┌──────────────┬───────────────────────────────────────┐
//   │  Sidebar     │  Topbar (title, status pill, search,   │
//   │  (fixed-     │  bell, avatar)                         │
//   │   width)     ├───────────────────────────────────────┤
//   │  · logo      │  Stat cards row (4 equal columns)      │
//   │  · nav list  ├───────────────────────────────────────┤
//   │              │  Two-column row: chart (2/3) + list(1/3)│
//   │              ├───────────────────────────────────────┤
//   │  · collapse  │  Bottom row: 2 equal cards (Logs/...)  │
//   │    (pinned)  │                                       │
//   └──────────────┴───────────────────────────────────────┘
//
// Pages (visible via sidebar nav, all rendered; only one shown at a time):
//   Goals   — the agent's goal, prominent and editable (auto-synthesize)
//   Jobs    — Kanban board by status (the project-management view)
//   Traces  — runs table → opens a Sheet showing prompt + reasoning + tool calls
//   Logs    — dense step log table → opens a Sheet with full detail
//   Memory  — agent memory + user memory (operator notes)
// =============================================================================

import type { FC } from "hono/jsx"

const ICONS = {
  logo: `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/></svg>`,
  grid: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>`,
  target: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.7" fill="currentColor"/></svg>`,
  briefcase: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="12" height="9" rx="1.5"/><path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h3A1.5 1.5 0 0 1 11 3.5V5"/></svg>`,
  activity: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8h3l2-5 4 10 2-5h3"/></svg>`,
  scroll: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3h10v10H3z"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`,
  brain: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M5 5a3 3 0 0 0 0 6M11 5a3 3 0 0 1 0 6M3 8h2M11 8h2"/></svg>`,
  settings: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>`,
  chevronLeft: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3L5 8l5 5"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><line x1="11" y1="11" x2="14" y2="14"/></svg>`,
  bell: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12V8a5 5 0 0 1 10 0v4M6.5 12a1.5 1.5 0 0 0 3 0"/></svg>`,
  play: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>`,
}

const nav: Array<{ id: string; label: string; icon: string; active?: boolean }> = [
  { id: "overview", label: "Overview", icon: ICONS.grid, active: true },
  { id: "goals", label: "Goals", icon: ICONS.target },
  { id: "jobs", label: "Jobs", icon: ICONS.briefcase },
  { id: "traces", label: "Traces", icon: ICONS.activity },
  { id: "logs", label: "Logs", icon: ICONS.scroll },
  { id: "memory", label: "Memory", icon: ICONS.brain },
  { id: "settings", label: "Settings", icon: ICONS.settings },
]

const Sidebar: FC = () => (
  <aside class="sb" id="sidebar">
    {/* Header: logo icon + wordmark */}
    <div class="sb-head">
      <span class="sb-logo" dangerouslySetInnerHTML={{ __html: ICONS.logo }} />
      <span class="sb-word">Harness</span>
    </div>

    {/* Vertical nav */}
    <nav class="sb-nav">
      {nav.map(item => (
        <a
          class={"sb-item" + (item.active ? " sb-item-active" : "")}
          data-page={item.id}
          onclick={`goPage('${item.id}')`}
        >
          <span class="sb-accent" />
          <span class="sb-icon" dangerouslySetInnerHTML={{ __html: item.icon }} />
          <span class="sb-label">{item.label}</span>
        </a>
      ))}
    </nav>

    {/* Pinned collapse toggle */}
    <div class="sb-foot">
      <button class="sb-collapse" onclick="collapseSidebar()" id="collapse-btn">
        <span dangerouslySetInnerHTML={{ __html: ICONS.chevronLeft }} />
        <span>Collapse</span>
      </button>
    </div>
  </aside>
)

const StatCard: FC<{ label: string; id: string; subId?: string; sub: string }> = ({
  label,
  id,
  subId,
  sub,
}) => (
  <div class="stat-card">
    <div class="stat-top">
      <span class="stat-label">{label}</span>
      <span class="stat-badge" />
    </div>
    <div class="stat-value">
      <span id={id}>—</span>
    </div>
    <div class="stat-sub" id={subId ?? "_x"}>
      {sub}
    </div>
  </div>
)

const Dashboard: FC = () => {
  return (
    <>
      {/* ───────────── Auth Screen ───────────── */}
      <div id="auth-screen" class="auth-screen">
        <div class="auth-card">
          <span class="sb-logo" dangerouslySetInnerHTML={{ __html: ICONS.logo }} />
          <h2>Agent Harness</h2>
          <p>Enter your dashboard token to continue.</p>
          <div class="form-group">
            <input
              type="password"
              id="token-input"
              placeholder="Dashboard token"
              autocomplete="off"
            />
          </div>
          <button onclick="authenticate()">Connect</button>
        </div>
      </div>

      {/* ───────────── App Shell (hidden until auth) ───────────── */}
      <div id="dashboard" class="app" style="display: none;">
        <Sidebar />

        {/* Main content area */}
        <main class="main">
          {/* Top bar (single row, full width) */}
          <header class="topbar">
            <div class="topbar-left">
              <h1 class="page-title" id="page-title">Overview</h1>
              <button
                class="pill"
                onclick="startRun()"
                title="Start a run on the goal"
              >
                <span dangerouslySetInnerHTML={{ __html: ICONS.play }} />
                <span>Run</span>
              </button>
              <button
                class="pill secondary"
                onclick="pauseRun()"
                title="Pause"
              >
                <span dangerouslySetInnerHTML={{ __html: ICONS.pause }} />
              </button>
            </div>
            <div class="topbar-right">
              <span id="status-badge" class="status-badge status-idle">
                IDLE
              </span>
              <div class="search">
                <span dangerouslySetInnerHTML={{ __html: ICONS.search }} />
                <input type="text" placeholder="Search…" id="search-input" oninput="onSearch(this.value)" />
              </div>
              <span class="bell">
                <span dangerouslySetInnerHTML={{ __html: ICONS.bell }} />
                <span class="bell-dot" />
              </span>
              <span class="avatar">A</span>
            </div>
          </header>

          {/* Body (scrollable) */}
          <div class="main-scroll">
            {/* ───────────── Overview page (default landing) ───────────── */}
            <section class="page" id="page-overview">
            {/* Stat cards row */}
            <section class="stat-row">
              <StatCard label="Goal status" id="stat-goal-status" sub="Last run —" subId="stat-last-run" />
              <StatCard label="Steps" id="stat-step" sub="of 100" subId="stat-max" />
              <StatCard label="Tokens used" id="stat-tokens" sub="no cap" subId="stat-tokens-budget" />
              <StatCard label="Jobs in pipeline" id="stat-jobs" sub="active cards" />
            </section>

            {/* ───────────── Two-column content row ───────────── */}
            <section class="row-two">
              {/* Left wider column (2/3): Token spend chart + active run */}
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Token spend</div>
                    <div class="card-sub">across recent runs</div>
                  </div>
                  <div class="legend">
                    <span class="leg"><i class="dot dot-in" />Prompt</span>
                    <span class="leg"><i class="dot dot-out" />Completion</span>
                    <span class="leg"><i class="dot dot-r" />Reasoning</span>
                  </div>
                </div>
                <svg
                  id="tokens-spark"
                  class="spark-big"
                  viewBox="0 0 480 160"
                  preserveAspectRatio="none"
                />
                <div class="card-sub" id="tokens-spark-axis">—</div>
              </div>

              {/* Right narrower column (1/3): Right-column breakdown list */}
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Pipeline by stage</div>
                    <div class="card-sub">live counts</div>
                  </div>
                </div>
                <div id="pipeline-mini" class="mini-list" />
              </div>
            </section>

            {/* ───────────── Two-column bottom row ───────────── */}
            <section class="row-eq-2">
              {/* Recent summaries card */}
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Recent runs</div>
                    <div class="card-sub">last run summaries</div>
                  </div>
                  <a class="link" onclick="goPage('traces')">View all</a>
                </div>
                <div id="summaries-list" class="scroll-list">
                  <div class="empty">No runs yet.</div>
                </div>
              </div>

              {/* Live trace card */}
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Live activity</div>
                    <div class="card-sub">
                      <span id="run-id-label">no active run</span>
                    </div>
                  </div>
                  <a class="link" onclick="goPage('logs')">View all</a>
                </div>
                <div id="live-events" class="scroll-list">
                  <div class="empty">Start a run to see live trace.</div>
                </div>
              </div>
            </section>
            </section>

            {/* ───────────── PAGES (one shown at a time) ───────────── */}

            {/* Page: Goals — the prominent platform */}
            <section class="page" id="page-goals" style="display:none;">
              <div class="hero-card">
                <div class="kicker">CURRENT GOAL</div>
                <div class="hero-goal" id="goal-text">—</div>
                <div class="hero-actions">
                  <button onclick="showModal('goal-modal')" class="primary-lg">
                    Edit goal
                  </button>
                  <button onclick="synthesizeGoal()" class="ghost-lg">
                    <span dangerouslySetInnerHTML={{ __html: ICONS.plus }} />
                    Auto-synthesize
                  </button>
                  <button onclick="startRun()" class="play-lg">
                    <span dangerouslySetInnerHTML={{ __html: ICONS.play }} />
                    Start run
                  </button>
                </div>
              </div>

              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Recent run summaries</div>
                    <div class="card-sub">every run ends with a model summary</div>
                  </div>
                  <button class="small secondary" onclick="loadSummaries()">
                    ↻ Refresh
                  </button>
                </div>
                <div id="summaries-list-page" class="scroll-list" />
              </div>

              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Schedules</div>
                    <div class="card-sub">cron rules the watchdog watches</div>
                  </div>
                  <button
                    class="small secondary"
                    onclick="showModal('schedule-modal')"
                  >
                    + Add
                  </button>
                </div>
                <div id="schedules-list" class="scroll-list">
                  <div class="empty">No schedules configured.</div>
                </div>
              </div>
            </section>

            {/* Page: Jobs (Kanban) */}
            <section class="page" id="page-jobs" style="display:none;">
              <div class="kanban" id="kanban-board">
                <div class="empty">Loading pipeline...</div>
              </div>
              <div style="margin-top:12px;">
                <button class="small secondary" onclick="showModal('job-modal')">
                  + Add job
                </button>
                <button class="small secondary" onclick="showModal('profile-modal')">
                  Profile
                </button>
                <button class="small secondary" onclick="startRun()">
                  Start discovery run
                </button>
              </div>
            </section>

            {/* Page: Traces */}
            <section class="page" id="page-traces" style="display:none;">
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Run traces</div>
                    <div class="card-sub">
                      each run = prompt + reasoning + tool calls + responses
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center;">
                    <button class="small secondary" onclick="loadRunsTable()">
                      ↻
                    </button>
                  </div>
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
                    <tr><td colspan={5}>No runs yet.</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Page: Logs (dense table) */}
            <section class="page" id="page-logs" style="display:none;">
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Activity log</div>
                    <div class="card-sub">
                      Step by step. Click a row for full input + output + tokens.
                    </div>
                  </div>
                  <button class="small secondary" onclick="loadLog()">
                    ↻ Refresh
                  </button>
                </div>
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Run</th>
                      <th>Step</th>
                      <th>Action</th>
                      <th>Agent</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody id="log-body">
                    <tr><td colspan={6} class="empty">No activity yet.</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Page: Memory (agent + user) */}
            <section class="page" id="page-memory" style="display:none;">
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Operator notes (User Memory)</div>
                    <div class="card-sub">
                      Human-authored. Injected as a high-authority prompt layer.
                    </div>
                  </div>
                </div>
                <div class="memory-form">
                  <input type="text" id="um-key-input" placeholder="key e.g. target_companies" />
                  <input type="text" id="um-value-input" placeholder="value" />
                  <button onclick="saveUserMemory()">Save</button>
                </div>
                <div id="um-list" class="scroll-list">
                  <div class="empty">No notes yet.</div>
                </div>
              </div>

              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Agent memory</div>
                    <div class="card-sub">
                      facts the agent chose to remember via the `remember` tool
                    </div>
                  </div>
                </div>
                <div class="memory-form">
                  <input type="text" id="memory-key-input" placeholder="key e.g. focus_topic" />
                  <input type="text" id="memory-value-input" placeholder="value" />
                  <button onclick="rememberFact()">Remember</button>
                </div>
                <div id="memory-list">
                  <div class="empty">Loading memory...</div>
                </div>
              </div>

              {/* Legacy tab containers (kept for back-compat with dashboard.js code paths) */}
              <div id="tab-overview" style="display:none;" />
              <div id="tab-pipeline" style="display:none;" />
              <div id="tab-research" style="display:none;" />
              <div id="tab-trace" style="display:none;" />
              <div id="tab-log" style="display:none;" />
              <div id="tab-memory" style="display:none;" />
            </section>

            {/* Page: Settings */}
            <section class="page" id="page-settings" style="display:none;">
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Configuration</div>
                    <div class="card-sub">model + budget (BYOK)</div>
                  </div>
                </div>
                <div id="settings-grid" class="settings-grid" />
                <button class="small secondary" onclick="showModal('goal-modal')">
                  Edit goal &amp; budget
                </button>
              </div>
              <div class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">Research</div>
                    <div class="card-sub">manual research trigger</div>
                  </div>
                  <button class="small secondary" onclick="showModal('research-modal')">
                    + Run
                  </button>
                </div>
                <div id="research-list" class="scroll-list">
                  <div class="empty">Use the modal to run a research sweep.</div>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>

      {/* ───────────── Sheet drawer (Trace / Log detail) ───────────── */}
      <div class="sheet-overlay" id="sheet-overlay" style="display:none;" onclick="closeSheet()" />
      <aside class="sheet" id="sheet" style="display:none;">
        <div class="sheet-head">
          <h3 id="sheet-title">Trace</h3>
          <button class="icon-btn" onclick="closeSheet()">✕</button>
        </div>
        <div class="sheet-body" id="sheet-body" />
      </aside>

      {/* Modals (existing IDs preserved for back-compat with dashboard.js) */}
      <div
        id="goal-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('goal-modal')"
      >
        <div class="modal">
          <h3>Edit goal</h3>
          <div class="form-group">
            <label class="form-label">Agent Goal</label>
            <textarea
              id="goal-input"
              rows={3}
              placeholder="What should the agent focus on?"
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Max Steps Per Run</label>
            <input
              type="number"
              id="max-steps-input"
              value="100"
              min="1"
              max="500"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Token Budget (0 = unlimited)</label>
            <input
              type="number"
              id="budget-input"
              value="0"
              min="0"
              step="10000"
              placeholder="e.g. 200000"
            />
            <div style="font-size: 11px; color: var(--muted-2); margin-top: 4px;">
              Soft ceiling on cumulative tokens spent per run. 0 disables the
              cap. With <code>reasoningEffort: xhigh</code>, set a real cap
              before billing.
            </div>
          </div>
          <div class="form-row">
            <button onclick="saveGoal()">Save</button>
            <button class="secondary" onclick="hideModal('goal-modal')">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <div
        id="schedule-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('schedule-modal')"
      >
        <div class="modal">
          <h3>Manage schedules</h3>
          <div id="schedule-list-modal"></div>
          <hr style="border-color: var(--border); margin: 16px 0;" />
          <h4 style="margin-bottom: 12px;">Add Schedule</h4>
          <div class="form-group">
            <label class="form-label">Cron Expression (UTC)</label>
            <input type="text" id="cron-input" placeholder="0 8 * * *" />
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
              Examples: <code>0 8 * * *</code> (daily 8am),{" "}
              <code>0 8,18 * * *</code> (8am+6pm), <code>0 */6 * * *</code>{" "}
              (every 6h)
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Focus</label>
            <select id="focus-input">
              <option value="all">All (research + jobs)</option>
              <option value="research">Research only</option>
              <option value="jobs">Jobs only</option>
            </select>
          </div>
          <div class="form-row">
            <button onclick="addSchedule()">Add Schedule</button>
            <button class="secondary" onclick="hideModal('schedule-modal')">
              Close
            </button>
          </div>
        </div>
      </div>

      <div
        id="job-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('job-modal')"
      >
        <div class="modal">
          <h3>Add job listing</h3>
          <div class="form-group">
            <label class="form-label">Company</label>
            <input type="text" id="job-company" placeholder="e.g. Cloudflare" />
          </div>
          <div class="form-group">
            <label class="form-label">Job Title</label>
            <input
              type="text"
              id="job-title"
              placeholder="e.g. Senior Software Engineer"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea
              id="job-description"
              rows={4}
              placeholder="Paste the job description here..."
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">URL</label>
            <input type="url" id="job-url" placeholder="https://..." />
          </div>
          <div class="form-row">
            <button onclick="addJob()">Add Job</button>
            <button class="secondary" onclick="hideModal('job-modal')">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <div
        id="profile-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('profile-modal')"
      >
        <div class="modal">
          <h3>Your profile</h3>
          <div class="form-group">
            <label class="form-label">CV / Resume</label>
            <textarea
              id="profile-cv"
              rows={8}
              placeholder="Paste your CV here..."
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Target Roles</label>
            <input
              type="text"
              id="profile-roles"
              placeholder="e.g. Senior Software Engineer, AI/ML Engineer"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Target Locations</label>
            <input
              type="text"
              id="profile-locations"
              placeholder="e.g. London, Remote"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Key Skills</label>
            <input
              type="text"
              id="profile-skills"
              placeholder="e.g. TypeScript, Python, React, Cloudflare Workers"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Preferences / Notes</label>
            <textarea
              id="profile-preferences"
              rows={3}
              placeholder="Salary expectations, work style preferences, etc."
            ></textarea>
          </div>
          <div class="form-row">
            <button onclick="saveProfile()">Save Profile</button>
            <button class="secondary" onclick="hideModal('profile-modal')">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <div
        id="research-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('research-modal')"
      >
        <div class="modal">
          <h3>Run research</h3>
          <div class="form-group">
            <label class="form-label">Topic</label>
            <input
              type="text"
              id="research-topic"
              placeholder="e.g. Cloudflare Agents SDK best practices"
            />
          </div>
          <div class="form-group">
            <label class="form-label">Depth</label>
            <select id="research-depth">
              <option value="quick">Quick (3 steps)</option>
              <option value="standard" selected>
                Standard (5 steps)
              </option>
              <option value="deep">Deep (10 steps)</option>
            </select>
          </div>
          <div class="form-row">
            <button onclick="runResearch()">Start Research</button>
            <button class="secondary" onclick="hideModal('research-modal')">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <div
        id="cover-letter-modal"
        class="modal-overlay"
        style="display: none;"
        onclick="if(event.target===this)hideModal('cover-letter-modal')"
      >
        <div class="modal">
          <h3>Cover letter</h3>
          <div
            id="cover-letter-content"
            style="white-space: pre-wrap; font-size: 14px; line-height: 1.7;"
          ></div>
          <button
            class="secondary"
            onclick="hideModal('cover-letter-modal')"
            style="margin-top: 16px;"
          >
            Close
          </button>
        </div>
      </div>
    </>
  )
}

export default Dashboard

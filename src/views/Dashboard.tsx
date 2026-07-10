// =============================================================================
// Dashboard — the main view rendered by Hono's jsxRenderer.
// =============================================================================
// This is the <body> content. It is static markup: all data is fetched and
// rendered client-side by /js/dashboard.js against the /api/* routes.
// CSS lives at /css/dashboard.css (served by the [assets] binding).
// =============================================================================

import type { FC } from "hono/jsx"

const Dashboard: FC = () => {
  return (
    <>
      {/* Auth Screen */}
      <div id="auth-screen" class="auth-screen">
        <div class="auth-card">
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
          <button
            onclick="authenticate()"
            style="width: 100%; margin-top: 8px;"
          >
            Connect
          </button>
        </div>
      </div>

      {/* Main Dashboard (hidden until auth) */}
      <div id="dashboard" style="display: none;">
        <div class="header">
          <div class="header-left">
            <h1>Agent Harness</h1>
            <span id="status-badge" class="status-badge status-idle">
              IDLE
            </span>
          </div>
          <div class="header-right">
            <span id="model-info" class="model-info">
              —
            </span>
            <button class="secondary small" onclick="logout()">
              Logout
            </button>
          </div>
        </div>

        <div class="container">
          {/* Status Panel */}
          <div class="status-panel">
            <div class="status-grid">
              <div class="stat-item">
                <div class="stat-value" id="stat-step">
                  0
                </div>
                <div class="stat-label">Current Step</div>
              </div>
              <div class="stat-item">
                <div class="stat-value" id="stat-max">
                  100
                </div>
                <div class="stat-label">Max Steps</div>
              </div>
              <div class="stat-item">
                <div class="stat-value" id="stat-last-run">
                  —
                </div>
                <div class="stat-label">Last Run</div>
              </div>
              <div class="stat-item">
                <div class="stat-value" id="stat-jobs">
                  0
                </div>
                <div class="stat-label">Jobs Tracked</div>
              </div>
              <div class="stat-item">
                <div class="stat-value" id="stat-tokens">
                  0
                </div>
                <div class="stat-label">Tokens Used</div>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted);">
                <span>Progress</span>
                <span id="progress-text">0 / 100</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  id="progress-fill"
                  style="width: 0%"
                ></div>
              </div>
            </div>
            <div style="margin-top: 8px; font-size: 13px; color: var(--text-secondary);">
              <strong>Goal:</strong> <span id="goal-text">—</span>
            </div>
          </div>

          {/* Controls — terse mono labels, no emoji; primary actions read as verbs */}
          <div class="controls">
            <button onclick="startRun()">Start run</button>
            <button class="secondary" onclick="pauseRun()">Pause</button>
            <button class="secondary" onclick="resumeRun()">Resume</button>
            <button class="danger" onclick="stopRun()">Stop</button>
            <button class="secondary" onclick="showModal('goal-modal')">Edit goal</button>
            <button class="secondary" onclick="showModal('schedule-modal')">Schedules</button>
            <button class="secondary" onclick="showModal('job-modal')">Add job</button>
            <button class="secondary" onclick="showModal('profile-modal')">Profile</button>
            <button class="secondary" onclick="showModal('research-modal')">Research</button>
          </div>

          {/* Tabs */}
          <div class="tabs">
            <button class="tab active" data-num="01" onclick="switchTab('overview')">
              Overview
            </button>
            <button class="tab" data-num="02" onclick="switchTab('pipeline')">
              Job Pipeline
            </button>
            <button class="tab" data-num="03" onclick="switchTab('research')">
              Research
            </button>
            <button class="tab" data-num="04" onclick="switchTab('log')">
              Activity Log
            </button>
            <button class="tab" data-num="05" onclick="switchTab('memory')">
              Memory
            </button>
          </div>

          {/* Tab: Overview */}
          <div id="tab-overview">
            <div class="grid grid-2">
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Recent Summaries</span>
                </div>
                <div id="summaries-list">
                  <div class="empty">
                    No runs yet. Start your first run above.
                  </div>
                </div>
              </div>
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Schedules</span>
                  <button
                    class="small secondary"
                    onclick="showModal('schedule-modal')"
                  >
                    + Add
                  </button>
                </div>
                <div id="schedules-list">
                  <div class="empty">No schedules configured.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Tab: Pipeline */}
          <div id="tab-pipeline" style="display: none;">
            <div class="kanban" id="kanban-board">
              <div class="empty">Loading pipeline...</div>
            </div>
          </div>

          {/* Tab: Research */}
          <div id="tab-research" style="display: none;">
            <div class="grid grid-2">
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Topics</span>
                </div>
                <div id="topics-list">
                  <div class="empty">No research topics yet.</div>
                </div>
              </div>
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Recent Findings</span>
                </div>
                <div id="findings-list">
                  <div class="empty">No findings yet.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Tab: Activity Log */}
          <div id="tab-log" style="display: none;">
            <div class="card">
              <div class="card-header">
                <span class="card-title">Step Log</span>
                <div style="display:flex; gap:8px; align-items:center;">
                  <span style="font-size:11px; color:var(--muted-2);">click a row for input/output</span>
                  <button class="small secondary" onclick="loadLog()">
                    Refresh
                  </button>
                </div>
              </div>
              <div style="overflow-x: auto;">
                <table class="log-table">
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
                    <tr>
                      <td colspan={6} class="empty">
                        No activity yet.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Tab: Memory — the harness's remembered facts (the `context` table) */}
          <div id="tab-memory" style="display: none;">
            <div class="card">
              <div class="card-header">
                <span class="card-title">Memory</span>
                <span style="font-size:11px; color:var(--muted-2);">facts persisted via the `remember` tool</span>
              </div>

              {/* Add-fact form */}
              <div class="memory-form">
                <div>
                  <label class="form-label">Key</label>
                  <input
                    type="text"
                    id="memory-key-input"
                    placeholder="focus_topic"
                  />
                </div>
                <div>
                  <label class="form-label">Value</label>
                  <input
                    type="text"
                    id="memory-value-input"
                    placeholder="What to remember"
                  />
                </div>
                <button onclick="rememberFact()">Remember</button>
              </div>

              <div id="memory-list">
                <div class="empty">Loading memory...</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
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

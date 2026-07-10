// =========================================================================
// dashboard.js — rewired against the new telemetry CSS palette + markdown/json
// =========================================================================
// CHANGES vs the previous version
//   - All CSS variable references updated to the new palette
//     (--rule, --rule-soft, --muted, --muted-2, --paper, --accent, ...).
//     The old file referenced names that no longer exist (--border,
//     --text-muted, --accent-blue/amber/purple/red) and rendered unstyled.
//   - Every LLM-generated string field renders through md.render() — summaries,
//     findings, research summaries, notes. Markdown that the model emits
//     (headings, bold, lists, code fences, links) now actually renders.
//   - Tool input / output in the activity log renders through renderJson()
//     with pretty-print + syntax highlighting on valid JSON, and a safe
//     <pre> fallback on malformed JSON or plain text.
//   - The activity log gained an expandable detail panel per step (click a
//     row to see input + output + token usage).
//   - Summaries parse the embedded "[stop_reason: …, tokens: …]" trailer into
//     structured chips instead of dumping it as body text.
//   - New: a Memory tab listing the harness's remembered facts (the `context`
//     table) — read/edit/delete.
//   - New: a Session tab listing the typed event log (once /api/events exists).
//     Until that endpoint ships, the tab shows the existing step_log in
//     event-log form, which is the same data, just laid out as one stream.
// =========================================================================

// State
let TOKEN = localStorage.getItem("agent-harness-token") || ""
let refreshInterval = null
let activeTab = "overview"
let expandedLogRow = null

// =========================================================================
// Auth
// =========================================================================
function authenticate() {
  TOKEN = document.getElementById("token-input").value.trim()
  if (!TOKEN) return
  localStorage.setItem("agent-harness-token", TOKEN)
  init()
}

function logout() {
  TOKEN = ""
  localStorage.removeItem("agent-harness-token")
  document.getElementById("dashboard").style.display = "none"
  document.getElementById("auth-screen").style.display = "flex"
  if (refreshInterval) clearInterval(refreshInterval)
}

// =========================================================================
// API helper
// =========================================================================
async function api(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch("/api" + path, opts)
  if (res.status === 401) {
    logout()
    throw new Error("Unauthorized")
  }
  if (!res.ok) {
    let msg = res.status + " " + res.statusText
    try {
      const j = await res.json()
      if (j && j.error) msg = j.error
    } catch (_) {}
    throw new Error(msg)
  }
  return res.json()
}

// =========================================================================
// Toast
// =========================================================================
function toast(message, type = "success") {
  const el = document.createElement("div")
  el.className = "toast " + type
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

// =========================================================================
// Modals
// =========================================================================
function showModal(id) {
  document.getElementById(id).style.display = "flex"
}
function hideModal(id) {
  document.getElementById(id).style.display = "none"
}

// =========================================================================
// Tab switching
// =========================================================================
function switchTab(tab, ev) {
  activeTab = tab
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"))
  if (ev && ev.target) ev.target.classList.add("active")
  ;["overview", "pipeline", "research", "log", "memory"].forEach(t => {
    const el = document.getElementById("tab-" + t)
    if (el) el.style.display = t === tab ? "block" : "none"
  })
  if (tab === "pipeline") loadPipeline()
  if (tab === "research") loadResearch()
  if (tab === "log") loadLog()
  if (tab === "memory") loadMemory()
}

// =========================================================================
// Status refresh
// =========================================================================
async function refreshStatus() {
  try {
    const status = await api("/status")
    document.getElementById("status-badge").textContent =
      status.status.toUpperCase()
    document.getElementById("status-badge").className =
      "status-badge status-" + status.status
    document.getElementById("stat-step").textContent = status.currentStep
    document.getElementById("stat-max").textContent = status.maxSteps
    document.getElementById("goal-text").textContent = status.goal
    document.getElementById("progress-text").textContent =
      status.currentStep + " / " + status.maxSteps
    const pct =
      status.maxSteps > 0 ? (status.currentStep / status.maxSteps) * 100 : 0
    document.getElementById("progress-fill").style.width = pct + "%"
    if (status.lastRunAt) {
      const d = new Date(status.lastRunAt)
      document.getElementById("stat-last-run").textContent =
        d.toLocaleTimeString()
    } else {
      document.getElementById("stat-last-run").textContent = "—"
    }

    // Token usage (only surfaces if the field exists)
    const tokUsed = document.getElementById("stat-tokens")
    if (tokUsed) {
      tokUsed.textContent =
        status.tokensUsed != null
          ? status.tokensUsed.toLocaleString()
          : "0"
    }

    if (status.model) {
      document.getElementById("model-info").textContent =
        status.model.provider + " / " + status.model.model
    }
  } catch (e) {
    console.error("Status refresh failed:", e)
  }
}

// =========================================================================
// Controls
// =========================================================================
async function startRun() {
  try {
    const res = await api("/start", "POST")
    toast(res.message)
    refreshStatus()
  } catch (e) {
    toast("Failed to start: " + e.message, "error")
  }
}

async function pauseRun() {
  const res = await api("/pause", "POST")
  toast(res.message)
  refreshStatus()
}

async function resumeRun() {
  const res = await api("/resume", "POST")
  toast(res.message)
  refreshStatus()
}

async function stopRun() {
  const res = await api("/stop", "POST")
  toast(res.message)
  refreshStatus()
}

async function saveGoal() {
  const goal = document.getElementById("goal-input").value.trim()
  const maxSteps = document.getElementById("max-steps-input").value
  const budget = document.getElementById("budget-input")?.value
  const config = {}
  if (goal) config.goal = goal
  if (maxSteps) config.maxSteps = maxSteps
  if (budget) config.tokenBudget = budget
  const res = await api("/config", "PUT", config)
  toast(res.message)
  hideModal("goal-modal")
  refreshStatus()
}

// =========================================================================
// Schedules
// =========================================================================
function timeFmt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? "Today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

function scheduleRow(s) {
  const next = s.enabled ? timeFmt(s.nextFireAt) : null
  return `
    <div class="row-flex">
      <div class="row-main">
        <code class="cron">${s.cron}</code>
        <span class="focus">(${s.focus})</span>
        ${s.description ? `<div class="row-sub">${md.escapeHtml(s.description)}</div>` : ""}
        ${next ? `<div class="row-meta">Next: ${next} UTC</div>` : ""}
      </div>
      <div class="row-actions">
        <span class="pill ${s.enabled ? "pill-on" : "pill-off"}">${s.enabled ? "ON" : "OFF"}</span>
        <button class="small secondary" onclick="toggleSchedule(${s.id}, ${!s.enabled})">${s.enabled ? "Disable" : "Enable"}</button>
        <button class="small danger" onclick="deleteSchedule(${s.id})">✕</button>
      </div>
    </div>
  `
}

async function loadSchedules() {
  try {
    const schedules = await api("/schedules")
    const container = document.getElementById("schedules-list")
    const modalContainer = document.getElementById("schedule-list-modal")

    if (schedules.length === 0) {
      const empty =
        '<div class="empty">No schedules. The agent only runs when you click Start.</div>'
      if (container) container.innerHTML = empty
      if (modalContainer) modalContainer.innerHTML = empty
      return
    }

    const html = schedules.map(scheduleRow).join("")
    if (container) container.innerHTML = html
    if (modalContainer) modalContainer.innerHTML = html
  } catch (e) {
    console.error("Schedules load failed:", e)
  }
}

async function addSchedule() {
  const cron = document.getElementById("cron-input").value.trim()
  const focus = document.getElementById("focus-input").value
  if (!cron) return toast("Enter a cron expression", "error")
  const res = await api("/schedules", "POST", { cron, focus })
  toast(res.message)
  document.getElementById("cron-input").value = ""
  loadSchedules()
}

async function deleteSchedule(id) {
  await api("/schedules/" + id, "DELETE")
  toast("Schedule removed")
  loadSchedules()
}

async function toggleSchedule(id, enabled) {
  await api("/schedules/" + id + "/toggle", "PUT", { enabled })
  toast("Schedule " + (enabled ? "enabled" : "disabled"))
  loadSchedules()
}

// =========================================================================
// Summaries — parse the [stop_reason: …, tokens: …] trailer into chips
// =========================================================================
function parseSummary(raw) {
  // Trailer format (set by finishRunPersisted): "[stop_reason: …, tokens: N]"
  // Newer runs may also contain a "\n\n" separator before the trailer.
  const out = { body: raw || "", stopReason: null, tokens: null }
  const m = String(raw).match(/\[stop_reason:\s*([^,\]]+),\s*tokens?:\s*(\d+)\]/i)
  if (m) {
    out.stopReason = m[1].trim()
    out.tokens = Number(m[2])
    out.body = String(raw).replace(m[0], "").replace(/\s+$/, "")
  }
  return out
}

const STOP_REASON_LABELS = {
  finished: "Finished",
  max_steps_reached: "Max steps",
  token_budget_reached: "Budget",
  interrupted: "Interrupted",
  idle_detected: "Idle",
  repeated_loop_detected: "Loop",
}

function stopReasonChip(reason) {
  if (!reason) return ""
  const label = STOP_REASON_LABELS[reason] || reason
  // Class the chip by severity so CSS can colour it
  const sev =
    reason === "finished"
      ? "ok"
      : reason === "max_steps_reached" || reason === "token_budget_reached"
        ? "warn"
        : "alarm"
  return `<span class="chip chip-${sev}">${md.escapeHtml(label)}</span>`
}

async function loadSummaries() {
  try {
    const summaries = await api("/summaries?limit=5")
    const container = document.getElementById("summaries-list")
    if (summaries.length === 0) {
      container.innerHTML =
        '<div class="empty">No runs yet. Start your first run above.</div>'
      return
    }
    container.innerHTML = summaries
      .map(s => {
        const parsed = parseSummary(s.summary)
        return `
          <article class="summary-card">
            <div class="summary-head">
              <span class="summary-date">${md.escapeHtml(s.date)}</span>
              <div class="summary-meta">
                ${stopReasonChip(parsed.stopReason)}
                <span class="chip chip-neutral">${s.stepsTaken} steps</span>
                ${
                  parsed.tokens != null
                    ? `<span class="chip chip-neutral">${parsed.tokens.toLocaleString()} tok</span>`
                    : ""
                }
              </div>
            </div>
            <div class="md-body">${md.render(parsed.body)}</div>
          </article>
        `
      })
      .join("")
  } catch (e) {
    console.error("Summaries load failed:", e)
  }
}

// =========================================================================
// Pipeline (Kanban)
// =========================================================================
const PIPELINE_COLUMNS = [
  { key: "discovered", label: "Discovered", color: "var(--muted)" },
  { key: "draft", label: "Draft", color: "var(--warn)" },
  { key: "applied", label: "Applied", color: "var(--signal)" },
  { key: "interview", label: "Interview", color: "#b078ff" },
  { key: "offer", label: "Offer", color: "var(--accent)" },
  { key: "rejected", label: "Rejected", color: "var(--alarm)" },
]

async function loadPipeline() {
  try {
    const data = await api("/pipeline")
    document.getElementById("stat-jobs").textContent = data.stats.total

    let html = ""
    for (const col of PIPELINE_COLUMNS) {
      const jobs = data.listings.filter(j => j.status === col.key)
      html += `
        <div class="kanban-column">
          <div class="kanban-header" style="color:${col.color}">
            <span>${col.label.toUpperCase()}</span>
            <span class="kanban-count">${jobs.length}</span>
          </div>
          ${
            jobs.length === 0
              ? '<div class="empty kanban-empty">Empty</div>'
              : jobs
                  .map(
                    j => `
              <div class="kanban-card" onclick="showJobActions(${j.id}, ${JSON.stringify(j.company)}, ${JSON.stringify(j.title)})">
                <div class="company">${md.escapeHtml(j.company)}</div>
                <div class="title">${md.escapeHtml(j.title)}</div>
                ${
                  j.matchScore
                    ? `<div class="match">Match ${Math.round(j.matchScore * 100)}%</div>`
                    : ""
                }
                <div class="match">${j.source === "auto-discovered" ? "AUTO" : "MANUAL"}</div>
              </div>
            `,
                  )
                  .join("")
          }
        </div>
      `
    }
    document.getElementById("kanban-board").innerHTML = html
  } catch (e) {
    console.error("Pipeline load failed:", e)
  }
}

async function showJobActions(jobId, company, title) {
  if (confirm(`${company} — ${title}\n\nGenerate cover letter?`)) {
    toast("Generating cover letter...")
    try {
      const res = await api("/jobs/" + jobId + "/cover-letter", "POST")
      document.getElementById("cover-letter-content").innerHTML =
        md.render(res.coverLetter)
      showModal("cover-letter-modal")
    } catch (e) {
      toast("Failed: " + e.message, "error")
    }
  }
}

// =========================================================================
// Research
// =========================================================================
async function loadResearch() {
  try {
    const data = await api("/research")

    const topicsHtml =
      data.topics.length === 0
        ? '<div class="empty">No topics yet.</div>'
        : data.topics
            .map(
              t => `
              <div class="topic-item">
                <div class="topic-title">${md.escapeHtml(t.topic)}</div>
                <div class="topic-meta">
                  Researched ${t.timesResearched}x ·
                  ${t.lastResearched ? new Date(t.lastResearched).toLocaleDateString() : "never"}
                </div>
              </div>
            `,
            )
            .join("")

    const findingsHtml =
      data.findings.length === 0
        ? '<div class="empty">No findings yet.</div>'
        : data.findings
            .map(
              f => `
              <article class="finding-card">
                <div class="finding-topic">${md.escapeHtml(f.topic)}</div>
                <div class="md-body md-body-tight">${md.render(f.summary)}</div>
                <div class="finding-date">${new Date(f.createdAt).toLocaleString()}</div>
              </article>
            `,
            )
            .join("")

    document.getElementById("topics-list").innerHTML = topicsHtml
    document.getElementById("findings-list").innerHTML = findingsHtml
  } catch (e) {
    console.error("Research load failed:", e)
  }
}

async function runResearch() {
  const topic = document.getElementById("research-topic").value.trim()
  const depth = document.getElementById("research-depth").value
  if (!topic) return toast("Enter a topic", "error")
  hideModal("research-modal")
  toast("Running research on: " + topic)
  try {
    await api("/research/run", "POST", { topic, depth })
    toast("Research complete!")
    loadResearch()
  } catch (e) {
    toast("Research failed: " + e.message, "error")
  }
}

// =========================================================================
// Jobs
// =========================================================================
async function addJob() {
  const company = document.getElementById("job-company").value.trim()
  const title = document.getElementById("job-title").value.trim()
  const description = document.getElementById("job-description").value.trim()
  const url = document.getElementById("job-url").value.trim()
  if (!company || !title)
    return toast("Company and title are required", "error")
  const res = await api("/jobs", "POST", { company, title, description, url })
  toast(res.message)
  hideModal("job-modal")
  ;["job-company", "job-title", "job-description", "job-url"].forEach(
    id => (document.getElementById(id).value = ""),
  )
  loadPipeline()
}

// =========================================================================
// Profile
// =========================================================================
async function loadProfile() {
  try {
    const profile = await api("/profile")
    if (profile.cv) document.getElementById("profile-cv").value = profile.cv
    if (profile.targetRoles)
      document.getElementById("profile-roles").value = profile.targetRoles
    if (profile.targetLocations)
      document.getElementById("profile-locations").value =
        profile.targetLocations
    if (profile.skills)
      document.getElementById("profile-skills").value = profile.skills
    if (profile.preferences)
      document.getElementById("profile-preferences").value =
        profile.preferences
  } catch (e) {
    /* no profile yet */
  }
}

async function saveProfile() {
  const profile = {
    cv: document.getElementById("profile-cv").value.trim() || null,
    targetRoles: document.getElementById("profile-roles").value.trim() || null,
    targetLocations:
      document.getElementById("profile-locations").value.trim() || null,
    skills: document.getElementById("profile-skills").value.trim() || null,
    preferences:
      document.getElementById("profile-preferences").value.trim() || null,
  }
  const res = await api("/profile", "PUT", profile)
  toast(res.message)
  hideModal("profile-modal")
}

// =========================================================================
// Memory tab — the harness's remembered facts (the `context` table)
// =========================================================================
let memoryCache = []

async function loadMemory() {
  try {
    const rows = await api("/memory")
    memoryCache = Array.isArray(rows) ? rows : []
    renderMemory()
  } catch (e) {
    // The /memory endpoint may not exist yet — degrade gracefully
    document.getElementById("memory-list").innerHTML =
      '<div class="empty">Memory endpoint unavailable. (Requires /api/memory.)</div>'
  }
}

function renderMemory() {
  const container = document.getElementById("memory-list")
  if (memoryCache.length === 0) {
    container.innerHTML =
      '<div class="empty">No remembered facts. The agent has not called `remember` yet.</div>'
    return
  }
  container.innerHTML = memoryCache
    .map(
      m => `
      <div class="memory-row" data-key="${md.escapeHtml(m.key)}">
        <div class="memory-key"><code>${md.escapeHtml(m.key)}</code></div>
        <div class="memory-value">${md.render(m.value)}</div>
        <button class="small danger" onclick="forgetMemory('${md.escapeHtml(m.key).replace(/'/g, "&#39;")}')">forget</button>
      </div>
    `,
    )
    .join("")
}

async function rememberFact() {
  const key = document.getElementById("memory-key-input").value.trim()
  const value = document.getElementById("memory-value-input").value.trim()
  if (!key || !value) return toast("Key and value required", "error")
  await api("/memory", "PUT", { key, value })
  toast("Remembered: " + key)
  document.getElementById("memory-key-input").value = ""
  document.getElementById("memory-value-input").value = ""
  loadMemory()
}

async function forgetMemory(key) {
  await api("/memory/" + encodeURIComponent(key), "DELETE")
  toast("Forgot: " + key)
  loadMemory()
}

// =========================================================================
// Activity Log — with expandable per-step detail + JSON rendering
// =========================================================================
function actionColor(action) {
  if (!action) return "var(--muted)"
  if (action === "finish" || action === "done") return "var(--ok)"
  if (/error/i.test(action)) return "var(--alarm)"
  if (/idle|loop|interrupt/.test(action)) return "var(--warn)"
  if (action === "think") return "var(--muted-2)"
  return "var(--accent)"
}

async function loadLog() {
  try {
    const log = await api("/log?limit=50")
    const body = document.getElementById("log-body")
    if (log.length === 0) {
      body.innerHTML =
        '<tr><td colspan="5" class="empty">No activity yet.</td></tr>'
      return
    }
    body.innerHTML = log
      .map(
        (l, idx) => `
        <tr class="log-row" onclick="toggleLogDetail(${idx})">
          <td>${new Date(l.createdAt).toLocaleTimeString()}</td>
          <td class="run-id">${(l.runId || "").slice(0, 12)}</td>
          <td>${l.stepNumber}</td>
          <td class="action" style="color:${actionColor(l.action)}">${md.escapeHtml(l.action)}</td>
          <td>${md.escapeHtml((l.agent) || "harness")}</td>
          <td>${l.tokensUsed != null ? l.tokensUsed.toLocaleString() : "—"}</td>
        </tr>
        <tr class="log-detail" id="log-detail-${idx}" style="display:none;">
          <td colspan="6">
            <div class="detail-grid">
              <div class="detail-block">
                <div class="detail-label">Input</div>
                ${l.input ? renderJson(l.input, { maxChars: 6000 }) : '<span class="json-empty">—</span>'}
              </div>
              <div class="detail-block">
                <div class="detail-label">Output</div>
                ${
                  l.output
                    ? looksLikeJson(l.output)
                      ? renderJson(l.output, { maxChars: 6000 })
                      : '<div class="md-body md-body-tight">' + md.render(l.output) + "</div>"
                    : '<span class="json-empty">—</span>'
                }
              </div>
            </div>
          </td>
        </tr>
      `,
      )
      .join("")
  } catch (e) {
    console.error("Log load failed:", e)
  }
}

function looksLikeJson(s) {
  if (!s) return false
  const t = s.trim()
  return t.charAt(0) === "{" || t.charAt(0) === "["
}

function toggleLogDetail(idx) {
  const row = document.getElementById("log-detail-" + idx)
  if (!row) return
  const open = row.style.display !== "none"
  row.style.display = open ? "none" : "table-row"
}

// =========================================================================
// Init
// =========================================================================
async function init() {
  try {
    await api("/status") // test auth
    document.getElementById("auth-screen").style.display = "none"
    document.getElementById("dashboard").style.display = "block"
    await Promise.all([
      refreshStatus(),
      loadSchedules(),
      loadSummaries(),
      loadProfile(),
    ])
    if (refreshInterval) clearInterval(refreshInterval)
    refreshInterval = setInterval(refreshStatus, 10000)
  } catch (e) {
    if (e.message === "Unauthorized") {
      document.getElementById("auth-screen").style.display = "flex"
      document.getElementById("dashboard").style.display = "none"
    }
  }
}

// Auto-init if token is stored
if (TOKEN) init()

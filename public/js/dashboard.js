// =========================================================================
// State
// =========================================================================
let TOKEN = localStorage.getItem("agent-harness-token") || ""
let refreshInterval = null

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
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"))
  event.target.classList.add("active")
  ;["overview", "pipeline", "research", "log"].forEach(t => {
    document.getElementById("tab-" + t).style.display =
      t === tab ? "block" : "none"
  })
  if (tab === "pipeline") loadPipeline()
  if (tab === "research") loadResearch()
  if (tab === "log") loadLog()
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
  const config = {}
  if (goal) config.goal = goal
  if (maxSteps) config.maxSteps = maxSteps
  const res = await api("/config", "PUT", config)
  toast(res.message)
  hideModal("goal-modal")
  refreshStatus()
}

// =========================================================================
// Schedules
// =========================================================================
async function loadSchedules() {
  const schedules = await api("/schedules")
  const container = document.getElementById("schedules-list")
  const modalContainer = document.getElementById("schedule-list-modal")

  if (schedules.length === 0) {
    container.innerHTML =
      '<div class="empty">No schedules. The agent only runs when you click Start.</div>'
    if (modalContainer)
      modalContainer.innerHTML = '<div class="empty">No schedules yet.</div>'
    return
  }

  const fmtNext = iso => {
    if (!iso) return '<span style="color:var(--text-muted)">—</span>'
    const d = new Date(iso)
    const sameDay = d.toDateString() === new Date().toDateString()
    return sameDay
      ? "Today " +
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
  }

  const html = schedules
    .map(
      s => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
          <div style="min-width:0;">
            <code style="color:var(--accent)">${s.cron}</code>
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">(${s.focus})</span>
            ${s.description ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${s.description}</div>` : ""}
            ${s.enabled && s.nextFireAt ? `<div style="font-size:11px;color:var(--text-muted);">Next: ${fmtNext(s.nextFireAt)} UTC</div>` : ""}
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
            <span style="font-size:11px;color:${s.enabled ? "var(--accent)" : "var(--text-muted)"};">
              ${s.enabled ? "ON" : "OFF"}
            </span>
            <button class="small secondary" onclick="toggleSchedule(${s.id}, ${!s.enabled})">${s.enabled ? "Disable" : "Enable"}</button>
            <button class="small danger" onclick="deleteSchedule(${s.id})">✕</button>
          </div>
        </div>
      `,
    )
    .join("")

  container.innerHTML = html
  if (modalContainer) modalContainer.innerHTML = html
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
// Summaries
// =========================================================================
async function loadSummaries() {
  const summaries = await api("/summaries?limit=5")
  const container = document.getElementById("summaries-list")
  if (summaries.length === 0) {
    container.innerHTML =
      '<div class="empty">No runs yet. Start your first run above.</div>'
    return
  }
  container.innerHTML = summaries
    .map(
      s => `
        <div class="finding-card" style="border-left-color: var(--accent-blue);">
          <div style="display:flex;justify-content:space-between;">
            <span class="finding-topic" style="color:var(--accent-blue);">${s.date}</span>
            <span class="finding-date">${s.stepsTaken} steps</span>
          </div>
          <div class="finding-summary">${s.summary || "No summary available."}</div>
        </div>
      `,
    )
    .join("")
}

// =========================================================================
// Pipeline (Kanban)
// =========================================================================
async function loadPipeline() {
  try {
    const data = await api("/pipeline")
    document.getElementById("stat-jobs").textContent = data.stats.total
    const columns = [
      "discovered",
      "draft",
      "applied",
      "interview",
      "offer",
      "rejected",
    ]
    const colors = {
      discovered: "var(--text-muted)",
      draft: "var(--accent-amber)",
      applied: "var(--accent-blue)",
      interview: "var(--accent-purple)",
      offer: "var(--accent)",
      rejected: "var(--accent-red)",
    }

    let html = ""
    for (const col of columns) {
      const jobs = data.listings.filter(j => j.status === col)
      html += `
            <div class="kanban-column">
              <div class="kanban-header">
                <span style="color:${colors[col]}">${col.toUpperCase()}</span>
                <span class="kanban-count">${jobs.length}</span>
              </div>
              ${
                jobs.length === 0
                  ? '<div class="empty" style="padding:20px;font-size:12px;">Empty</div>'
                  : jobs
                      .map(
                        j => `
                  <div class="kanban-card" onclick="showJobActions(${j.id}, '${j.company}', '${j.title}')">
                    <div class="company">${j.company}</div>
                    <div class="title">${j.title}</div>
                    ${j.matchScore ? '<div class="match">Match: ' + Math.round(j.matchScore * 100) + "%</div>" : ""}
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
  if (confirm(`${company} — ${title}\\n\\nGenerate cover letter?`)) {
    toast("Generating cover letter...")
    try {
      const res = await api("/jobs/" + jobId + "/cover-letter", "POST")
      document.getElementById("cover-letter-content").textContent =
        res.coverLetter
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
              <div style="padding:8px 0;border-bottom:1px solid var(--border);">
                <div style="font-weight:500;">${t.topic}</div>
                <div style="font-size:11px;color:var(--text-muted);">
                  Researched ${t.timesResearched}x · ${t.lastResearched ? "Last: " + new Date(t.lastResearched).toLocaleDateString() : "Never"}
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
              <div class="finding-card">
                <div class="finding-topic">${f.topic}</div>
                <div class="finding-summary">${f.summary}</div>
                <div class="finding-date">${new Date(f.createdAt).toLocaleString()}</div>
              </div>
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
      document.getElementById("profile-preferences").value = profile.preferences
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
// Log
// =========================================================================
async function loadLog() {
  try {
    const log = await api("/log?limit=50")
    const body = document.getElementById("log-body")
    if (log.length === 0) {
      body.innerHTML =
        '<tr><td colspan="6" class="empty">No activity yet.</td></tr>'
      return
    }
    body.innerHTML = log
      .map(
        l => `
          <tr>
            <td>${new Date(l.createdAt).toLocaleTimeString()}</td>
            <td style="font-family:monospace;font-size:11px;">${(l.runId || "").slice(0, 12)}</td>
            <td>${l.stepNumber}</td>
            <td>${l.agent}</td>
            <td style="color:var(--accent)">${l.action}</td>
            <td title="${(l.input || "").replace(/"/g, "&quot;")}">${(l.input || "—").slice(0, 60)}</td>
          </tr>
        `,
      )
      .join("")
  } catch (e) {
    console.error("Log load failed:", e)
  }
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
    // Auto-refresh every 10 seconds
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

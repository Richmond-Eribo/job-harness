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
let activePage = "overview"
let sidebarCollapsed = false
let livePollInterval = null
let lastLiveSeq = 0
let currentLiveRunId = null

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
  ;["overview", "pipeline", "research", "trace", "log", "memory"].forEach(t => {
    const el = document.getElementById("tab-" + t)
    if (el) el.style.display = t === tab ? "block" : "none"
  })
  if (tab === "pipeline") loadPipeline()
  if (tab === "research") loadResearch()
  if (tab === "trace") loadTraceRuns()
  if (tab === "log") loadLog()
  if (tab === "memory") loadMemory()
}

// =========================================================================
// Status refresh — now updates the KPI tiles, progress ring, and sparkline
// =========================================================================
async function refreshStatus() {
  try {
    const status = await api("/status")

    // Status badge (topbar)
    const sb = document.getElementById("status-badge")
    if (sb) {
      sb.textContent = status.status.toUpperCase()
      sb.className = "status-badge status-" + status.status
    }

    // Stat: goal status
    const gs = document.getElementById("stat-goal-status")
    if (gs) gs.textContent = status.status

    // Stat: steps + max
    const stepEl = document.getElementById("stat-step")
    if (stepEl) stepEl.textContent = status.currentStep
    const maxEl = document.getElementById("stat-max")
    if (maxEl) maxEl.textContent = "of " + (status.maxSteps ?? 100)

    // Stat: tokens + budget
    const tokUsed = status.tokensUsed != null ? status.tokensUsed : 0
    const tokEl = document.getElementById("stat-tokens")
    if (tokEl) tokEl.textContent = tokUsed.toLocaleString()
    const budgetEl = document.getElementById("stat-tokens-budget")
    if (budgetEl) {
      const budget = status.tokenBudget || 0
      budgetEl.textContent =
        budget > 0
          ? (tokUsed / 1000).toFixed(1) +
            "k / " +
            (budget / 1000).toFixed(0) +
            "k"
          : "no cap"
    }

    // Last run + recent run count
    if (status.lastRunAt) {
      const d = new Date(status.lastRunAt)
      const lr = document.getElementById("stat-last-run")
      if (lr)
        lr.textContent =
          "Last run " +
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else {
      const lr = document.getElementById("stat-last-run")
      if (lr) lr.textContent = "No runs yet"
    }

    // Goal text (hero on Goals page)
    const goalEl = document.getElementById("goal-text")
    if (goalEl) goalEl.textContent = status.goal || "(no goal set)"

    // Active run label + live polling
    const runLabel = document.getElementById("run-id-label")
    if (status.status === "running" && status.runId) {
      if (runLabel) runLabel.textContent = status.runId.slice(0, 16)
      currentLiveRunId = status.runId
      startLivePoll(status.runId)
    } else {
      if (runLabel) runLabel.textContent = status.status + " — no active run"
      // keep showing last events; just stop polling
    }

    // Autorun table refresh when on traces page
    if (activePage === "traces") loadRunsTable().catch(() => {})
    if (activePage === "logs") loadLog().catch(() => {})

    // Model info (kept for back-compat if element exists)
    if (status.model) {
      const mi = document.getElementById("model-info")
      if (mi)
        mi.textContent =
          status.model.provider + " / " + status.model.model
    }

    // Refresh the sparkline (best-effort) and pipeline mini
    renderSparkline().catch(() => {})
    loadPipelineMini().catch(() => {})
  } catch (e) {
    console.error("Status refresh failed:", e)
  }
}

// =========================================================================
// Sparkline — inline SVG area chart of token spend over recent runs.
// No charting lib; zero deps; collapses gracefully to empty when no data.
// =========================================================================
async function renderSparkline() {
  const el = document.getElementById("tokens-spark")
  const axisEl = document.getElementById("tokens-spark-axis")
  if (!el) return

  const runs = await api("/runs?limit=12")
  // Oldest → newest so the line reads left-to-right
  const tokens = (Array.isArray(runs) ? runs : [])
    .map(r => r.tokens ?? 0)
    .filter(t => typeof t === "number" && t > 0)
    .reverse()

  if (tokens.length === 0) {
    el.innerHTML =
      '<text x="120" y="28" text-anchor="middle" fill="var(--muted-2)" font-size="10" font-family="var(--mono)">no runs yet</text>'
    if (axisEl) axisEl.textContent = "—"
    return
  }

  const max = Math.max(...tokens, 1)
  const w = 240,
    h = 48,
    pad = 4
  const step = tokens.length > 1 ? (w - pad * 2) / (tokens.length - 1) : 0
  const pts = tokens
    .map((t, i) => {
      const x = pad + i * step
      const y = h - pad - (t / max) * (h - pad * 2)
      return x.toFixed(1) + "," + y.toFixed(1)
    })
    .join(" ")
  const lastX = pad + (tokens.length - 1) * step
  const areaPts =
    pad + "," + (h - pad) + " " + pts + " " + lastX + "," + (h - pad)

  el.innerHTML =
    '<polygon points="' +
    areaPts +
    '" fill="var(--accent-dim)" stroke="none" />' +
    '<polyline points="' +
    pts +
    '" fill="none" stroke="var(--accent)" stroke-width="1.5" />'
  if (axisEl) {
    axisEl.textContent =
      "last " +
      tokens.length +
      " run" +
      (tokens.length === 1 ? "" : "s") +
      " · max " +
      (max / 1000).toFixed(1) +
      "k"
  }
}

// =========================================================================
// Dropdown + click-away
// =========================================================================
function toggleDropdown(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.style.display = el.style.display === "none" ? "block" : "none"
}
function closeDropdown(id) {
  const el = document.getElementById(id)
  if (el) el.style.display = "none"
}
document.addEventListener("click", e => {
  // Close any open dropdown when the click is outside a .dropdown
  if (!e.target.closest(".dropdown")) {
    document.querySelectorAll(".dropdown-menu").forEach(m => {
      m.style.display = "none"
    })
  }
})

// =========================================================================
// Trace tab — run picker + per-step reasoning breakdown
// =========================================================================
async function loadTraceRuns() {
  try {
    const runs = await api("/runs?limit=20")
    const sel = document.getElementById("trace-run-select")
    if (!sel) return
    const current = sel.value
    if (!Array.isArray(runs) || runs.length === 0) {
      sel.innerHTML = '<option value="">(no runs yet)</option>'
      document.getElementById("trace-list").innerHTML =
        '<div class="empty">No runs yet. Start a run from the dashboard, then refresh.</div>'
      return
    }
    sel.innerHTML = runs
      .map(r => {
        const label =
          r.runId.slice(0, 12) +
          " · " +
          r.steps +
          " steps" +
          (r.tokens != null ? " · " + r.tokens.toLocaleString() + " tok" : "")
        return (
          '<option value="' +
          md.escapeHtml(r.runId) +
          '">' +
          md.escapeHtml(label) +
          "</option>"
        )
      })
      .join("")
    // Preserve selection if still present, else auto-pick the latest
    if (current && runs.find(r => r.runId === current)) {
      sel.value = current
    }
    if (sel.value) loadTrace()
  } catch (e) {
    const el = document.getElementById("trace-list")
    if (el)
      el.innerHTML =
        '<div class="empty">/api/runs unavailable: ' +
        md.escapeHtml(e.message) +
        "</div>"
  }
}

async function loadTrace() {
  const sel = document.getElementById("trace-run-select")
  const runId = sel ? sel.value : ""
  const container = document.getElementById("trace-list")
  if (!container) return
  if (!runId) {
    container.innerHTML = '<div class="empty">Pick a run above.</div>'
    return
  }
  container.innerHTML =
    '<div class="empty"><span class="trace-pending"></span>Loading trace…</div>'
  try {
    const trace = await api("/run/" + encodeURIComponent(runId) + "/trace")
    if (!Array.isArray(trace) || trace.length === 0) {
      container.innerHTML =
        '<div class="empty">No trace rows for this run.</div>'
      return
    }
    container.innerHTML = trace
      .map(t => {
        // Usage chips
        const u = t.usage || {}
        const usageBar =
          u.totalTokens != null || u.promptTokens != null
            ? '<div class="trace-usage">' +
              (u.promptTokens != null
                ? '<span class="chip chip-neutral">prompt ' +
                  u.promptTokens.toLocaleString() +
                  "</span>"
                : "") +
              (u.completionTokens != null
                ? '<span class="chip chip-neutral">comp ' +
                  u.completionTokens.toLocaleString() +
                  "</span>"
                : "") +
              (u.reasoningTokens != null
                ? '<span class="chip chip-warn">reasoning ' +
                  u.reasoningTokens.toLocaleString() +
                  "</span>"
                : "") +
              (u.totalTokens != null
                ? '<span class="chip chip-neutral">' +
                  u.totalTokens.toLocaleString() +
                  " total</span>"
                : "") +
              (t.durationMs != null
                ? '<span class="chip chip-neutral">' +
                  (t.durationMs / 1000).toFixed(1) +
                  "s</span>"
                : "") +
              "</div>"
            : ""

        const reasoning = t.reasoning
          ? '<details open><summary>Reasoning</summary><div class="trace-reasoning-block md-body md-body-tight">' +
            md.render(t.reasoning) +
            "</div></details>"
          : '<details><summary>Reasoning</summary><div class="empty">(none captured — provider did not return reasoning)</div></details>'

        const text = t.text
          ? '<details><summary>Model text</summary><div class="md-body md-body-tight">' +
            md.render(t.text) +
            "</div></details>"
          : ""

        const action =
          t.action && t.action !== "think"
            ? "<details><summary>Tool call: <code>" +
              md.escapeHtml(t.action) +
              "</code></summary>" +
              (t.input
                ? renderJson(t.input, { maxChars: 6000 })
                : '<span class="json-empty">—</span>') +
              "</details>"
            : ""

        const out = t.output
          ? "<details><summary>Output</summary>" +
            (looksLikeJson(t.output)
              ? renderJson(t.output, { maxChars: 6000 })
              : '<div class="md-body md-body-tight">' +
                md.render(t.output) +
                "</div>") +
            "</details>"
          : ""

        const warn =
          t.warnings && t.warnings.length
            ? "<details><summary>Warnings (" +
              t.warnings.length +
              ')</summary><pre class="json-pre">' +
              md.escapeHtml(t.warnings.join("\n")) +
              "</pre></details>"
            : ""

        return (
          '<article class="trace-card">' +
          '<div class="trace-head">' +
          '<span class="trace-step">#' +
          t.stepNumber +
          "</span>" +
          '<span class="trace-action">' +
          md.escapeHtml(t.action || "think") +
          "</span>" +
          (t.model
            ? '<span class="trace-model">' + md.escapeHtml(t.model) + "</span>"
            : "") +
          "</div>" +
          usageBar +
          reasoning +
          text +
          action +
          out +
          warn +
          "</article>"
        )
      })
      .join("")
  } catch (e) {
    container.innerHTML =
      '<div class="empty">Failed to load trace: ' +
      md.escapeHtml(e.message) +
      "</div>"
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
        <tr class="log-row" onclick='onLogRowClick(${JSON.stringify(l).replace(/'/g, "&#39;")})'>
          <td>${new Date(l.createdAt).toLocaleTimeString()}</td>
          <td class="run-id">${(l.runId || "").slice(0, 12)}</td>
          <td>${l.stepNumber}</td>
          <td class="action" style="color:${actionColor(l.action)}">${md.escapeHtml(l.action)}</td>
          <td>${md.escapeHtml((l.agent) || "harness")}</td>
          <td>${l.tokensUsed != null ? l.tokensUsed.toLocaleString() : "—"}</td>
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
    document.getElementById("dashboard").style.display = "grid"
    // Default to the Overview page (dashboard at-a-glance)
    goPage("overview")
    await Promise.all([
      refreshStatus(),
      loadSchedules(),
      loadProfile(),
    ])
    if (refreshInterval) clearInterval(refreshInterval)
    refreshInterval = setInterval(refreshStatus, 8000)
  } catch (e) {
    if (e.message === "Unauthorized") {
      document.getElementById("auth-screen").style.display = "flex"
      document.getElementById("dashboard").style.display = "none"
    }
  }
}

// Auto-init if token is stored
if (TOKEN) init()

// =========================================================================
// v3 — Page router (sidebar nav)
// =========================================================================
const PAGES = ["overview", "goals", "jobs", "traces", "logs", "memory", "settings"]
const PAGE_TITLES = {
  overview: "Overview",
  goals: "Goals",
  jobs: "Jobs",
  traces: "Traces",
  logs: "Logs",
  memory: "Memory",
  settings: "Settings",
}

function goPage(id) {
  if (!PAGES.includes(id)) return
  activePage = id
  // Show one page, hide the others
  PAGES.forEach(p => {
    const el = document.getElementById("page-" + p)
    if (el) el.style.display = p === id ? "block" : "none"
  })
  // Active state in the sidebar
  document.querySelectorAll(".sb-item").forEach(item => {
    item.classList.toggle("sb-item-active", item.dataset.page === id)
  })
  // Top bar title
  const t = document.getElementById("page-title")
  if (t) t.textContent = PAGE_TITLES[id] || id
  // Lazy-load the page's data
  if (id === "overview") {
    loadSummaries()
    loadPipelineMini()
    renderSparkline()
  }
  if (id === "goals") {
    loadSummariesPage()
    loadSchedules()
  }
  if (id === "jobs") loadPipeline()
  if (id === "traces") loadRunsTable()
  if (id === "logs") loadLog()
  if (id === "memory") {
    loadMemory()
    loadUserMemory()
  }
  if (id === "settings") loadSettings()
}

function collapseSidebar() {
  sidebarCollapsed = !sidebarCollapsed
  document.getElementById("dashboard").classList.toggle(
    "sidebar-collapsed",
    sidebarCollapsed,
  )
}

// =========================================================================
// Onboarding the Goals page summaries
// =========================================================================
async function loadSummariesPage() {
  try {
    const summaries = await api("/summaries?limit=8")
    const container = document.getElementById("summaries-list-page")
    if (!container) return
    if (!Array.isArray(summaries) || summaries.length === 0) {
      container.innerHTML =
        '<div class="empty">No runs yet. Use Start run above.</div>'
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
    /* ignore */
  }
}

// =========================================================================
// Pipeline mini (right column of dashboard top)
// =========================================================================
async function loadPipelineMini() {
  try {
    const data = await api("/pipeline")
    const total = data.stats?.total ?? 0
    const jobsEl = document.getElementById("stat-jobs")
    if (jobsEl) jobsEl.textContent = total
    const byStatus = data.stats?.byStatus || {}
    const rows = PIPELINE_COLUMNS.map(col => {
      const n = byStatus[col.key] || 0
      const pct = total > 0 ? Math.round((n / total) * 100) : 0
      return `
        <div class="mini-row">
          <div class="mini-top">
            <span class="mini-label">${col.label}</span>
            <span class="mini-value">${n}</span>
          </div>
          <div class="mini-bar"><span style="width:${pct}%"></span></div>
        </div>
      `
    }).join("")
    const el = document.getElementById("pipeline-mini")
    if (el) el.innerHTML = rows || '<div class="empty">No jobs.</div>'
  } catch (e) {
    /* ignore */
  }
}

// =========================================================================
// Runs table (Traces page) — click a row → open Sheet with trace_events
// =========================================================================
async function loadRunsTable() {
  try {
    const runs = await api("/runs?limit=30")
    const body = document.getElementById("runs-table-body")
    if (!body) return
    if (!Array.isArray(runs) || runs.length === 0) {
      body.innerHTML =
        '<tr><td colspan="5" class="empty">No runs yet. Start a run on the Goals page.</td></tr>'
      return
    }
    body.innerHTML = runs
      .map(
        r => `
        <tr onclick="openTraceSheet('${md
          .escapeHtml(r.runId)
          .replace(/'/g, "&#39;")}')">
          <td>${new Date(r.createdAt).toLocaleString()}</td>
          <td><code>${md.escapeHtml(r.runId.slice(0, 14))}</code></td>
          <td>${r.steps ?? 0}</td>
          <td>${r.tokens != null ? r.tokens.toLocaleString() : "—"}</td>
          <td><span class="link">Open →</span></td>
        </tr>
      `,
      )
      .join("")
  } catch (e) {
    /* ignore */
  }
}

// =========================================================================
// Sheet drawer — renders trace_events for a run (prompt + reasoning + tools)
// =========================================================================
async function openTraceSheet(runId) {
  openSheet("Trace — " + runId.slice(0, 14))
  const body = document.getElementById("sheet-body")
  body.innerHTML = '<div class="empty">Loading trace…</div>'
  try {
    const events = await api(
      "/runs/" + encodeURIComponent(runId) + "/events?limit=500",
    )
    if (!Array.isArray(events) || events.length === 0) {
      body.innerHTML =
        '<div class="empty">No trace events for this run. (Runs started before the v3 trace_events migration have no detail.)</div>'
      return
    }
    body.innerHTML = events.map(renderEvent).join("")
  } catch (e) {
    body.innerHTML =
      '<div class="empty">Failed to load: ' +
      md.escapeHtml(e.message) +
      "</div>"
  }
}

function openLogSheet(stepLogEntry) {
  openSheet("Log detail — step " + stepLogEntry.stepNumber)
  const body = document.getElementById("sheet-body")
  const cap = 6000
  body.innerHTML = `
    <div class="ev">
      <div class="ev-head"><span class="ev-seq">#${stepLogEntry.stepNumber}</span>
        <span class="ev-type ev-type-tool_call">${md.escapeHtml(
          stepLogEntry.action,
        )}</span>
        <span class="ev-meta">${new Date(
          stepLogEntry.createdAt,
        ).toLocaleString()}</span>
      </div>
      <div class="ev-body">
        <div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin-bottom:4px;">Input</div>
        ${
          stepLogEntry.input
            ? renderJson(stepLogEntry.input, { maxChars: cap })
            : '<span class="empty">—</span>'
        }
        <div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin:8px 0 4px;">Output</div>
        ${
          stepLogEntry.output
            ? looksLikeJson(stepLogEntry.output)
              ? renderJson(stepLogEntry.output, { maxChars: cap })
              : '<div class="md-body md-body-tight">' +
                md.render(stepLogEntry.output) +
                "</div>"
            : '<span class="empty">—</span>'
        }
        ${
          stepLogEntry.reasoning
            ? '<div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin:8px 0 4px;">Reasoning</div><div class="md-body md-body-tight">' +
              md.render(stepLogEntry.reasoning) +
              "</div>"
            : ""
        }
      </div>
    </div>
  `
}

function renderEvent(ev) {
  const typeClass = "ev-type-" + ev.eventType
  let meta = ""
  if (ev.tokensIn != null || ev.tokensOut != null) {
    const parts = []
    if (ev.tokensIn != null) parts.push("in " + ev.tokensIn)
    if (ev.tokensOut != null) parts.push("out " + ev.tokensOut)
    if (ev.tokensReasoning != null)
      parts.push("reasoning " + ev.tokensReasoning)
    meta = parts.join(" · ")
  }
  if (ev.durationMs != null) meta += (meta ? " · " : "") + (ev.durationMs / 1000).toFixed(1) + "s"
  if (ev.model) meta += (meta ? " · " : "") + ev.model

  // Body depends on event type
  let bodyHtml = ""
  if (ev.eventType === "system" || ev.eventType === "prompt") {
    bodyHtml = ev.payload
      ? "<details><summary>Show " +
        (ev.eventType === "system" ? "full prompt" : "messages") +
        "</summary><pre>" +
        md.escapeHtml(formatMaybeJson(ev.payload)) +
        "</pre></details>"
      : '<span class="empty">—</span>'
  } else if (ev.eventType === "reasoning") {
    bodyHtml = ev.payload
      ? '<div class="md-body md-body-tight">' + md.render(ev.payload) + "</div>"
      : '<span class="empty">(none)</span>'
  } else if (ev.eventType === "text") {
    bodyHtml = ev.payload
      ? '<div class="md-body md-body-tight">' + md.render(ev.payload) + "</div>"
      : '<span class="empty">—</span>'
  } else if (ev.eventType === "tool_call" || ev.eventType === "tool_result") {
    bodyHtml = ev.payload
      ? "<pre>" + md.escapeHtml(formatMaybeJson(ev.payload)) + "</pre>"
      : '<span class="empty">—</span>'
  } else if (ev.eventType === "step_end" || ev.eventType === "run_end" || ev.eventType === "run_start" || ev.eventType === "error") {
    bodyHtml = ev.payload
      ? "<pre>" + md.escapeHtml(formatMaybeJson(ev.payload)) + "</pre>"
      : '<span class="empty">—</span>'
  } else {
    bodyHtml = ev.payload
      ? "<pre>" + md.escapeHtml(ev.payload) + "</pre>"
      : '<span class="empty">—</span>'
  }

  return `
    <div class="ev">
      <div class="ev-head">
        <span class="ev-seq">${ev.seq}</span>
        <span class="ev-type ${typeClass}">${md.escapeHtml(ev.eventType)}</span>
        ${
          ev.label
            ? '<span class="ev-label">' + md.escapeHtml(ev.label) + "</span>"
            : ""
        }
        ${ev.stepNumber != null ? '<span class="ev-label">step ' + ev.stepNumber + "</span>" : ""}
        ${meta ? '<span class="ev-meta">' + md.escapeHtml(meta) + "</span>" : ""}
      </div>
      <div class="ev-body">${bodyHtml}</div>
    </div>
  `
}

function formatMaybeJson(s) {
  // If valid JSON, pretty-print; else return as-is.
  try {
    const parsed = JSON.parse(s)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return s
  }
}

function openSheet(title) {
  document.getElementById("sheet-title").textContent = title || "Detail"
  document.getElementById("sheet-overlay").style.display = "block"
  document.getElementById("sheet").style.display = "flex"
  document.body.style.overflow = "hidden"
}
function closeSheet() {
  document.getElementById("sheet-overlay").style.display = "none"
  document.getElementById("sheet").style.display = "none"
  document.body.style.overflow = ""
}

// Make log rows open the sheet
function onLogRowClick(entry) {
  openLogSheet(entry)
}

// =========================================================================
// Live activity poll — last N trace events while a run is active
// =========================================================================
function startLivePoll(runId) {
  if (currentLiveRunId === runId && livePollInterval) return
  currentLiveRunId = runId
  lastLiveSeq = 0
  if (livePollInterval) clearInterval(livePollInterval)
  const tick = async () => {
    try {
      // All recent events (in reverse), show the latest 15
      const events = await api("/trace-events?limit=40")
      const el = document.getElementById("live-events")
      if (!el) return
      if (!Array.isArray(events) || events.length === 0) {
        el.innerHTML = '<div class="empty">No events yet…</div>'
        return
      }
      // events come back ordered; take the 15 newest
      const recent = events.slice(-15).reverse()
      el.innerHTML = recent
        .map(ev => {
          const payloadPreview = (ev.payload || "")
            .replace(/\s+/g, " ")
            .slice(0, 80)
          return `
            <div class="live-line" onclick="openTraceSheet('${md
              .escapeHtml(ev.runId)
              .replace(/'/g, "&#39;")}')">
              <span class="live-seq">${ev.seq}</span>
              <span class="live-type ev-type-${ev.eventType}">${md.escapeHtml(
                ev.eventType,
              )}</span>
              <span class="live-payload">${md.escapeHtml(
                (ev.label || "") + (payloadPreview ? " · " + payloadPreview : ""),
              )}</span>
            </div>
          `
        })
        .join("")
    } catch (e) {
      /* ignore */
    }
  }
  tick()
  livePollInterval = setInterval(tick, 3000)
}

function stopLivePoll() {
  if (livePollInterval) clearInterval(livePollInterval)
  livePollInterval = null
}

// =========================================================================
// User memory (human-authored notes, dashboard Memory page)
// =========================================================================
let userMemoryCache = []

async function loadUserMemory() {
  try {
    const rows = await api("/user-memory")
    userMemoryCache = Array.isArray(rows) ? rows : []
    renderUserMemory()
  } catch (e) {
    const el = document.getElementById("um-list")
    if (el)
      el.innerHTML =
        '<div class="empty">/api/user-memory unavailable.</div>'
  }
}

function renderUserMemory() {
  const container = document.getElementById("um-list")
  if (!container) return
  if (userMemoryCache.length === 0) {
    container.innerHTML =
      '<div class="empty">No operator notes yet. Add via the form above — these are injected into every system prompt.</div>'
    return
  }
  container.innerHTML = userMemoryCache
    .map(
      m => `
      <div class="memory-row" data-key="${md.escapeHtml(m.key)}">
        <div class="memory-key"><code>${md.escapeHtml(m.key)}</code></div>
        <div class="memory-value">${md.render(m.value)}</div>
        <button class="small danger" onclick="forgetUserMemory('${md
          .escapeHtml(m.key)
          .replace(/'/g, "&#39;")}')">remove</button>
      </div>
    `,
    )
    .join("")
}

async function saveUserMemory() {
  const key = document.getElementById("um-key-input").value.trim()
  const value = document.getElementById("um-value-input").value.trim()
  if (!key || !value) return toast("Key and value required", "error")
  await api("/user-memory", "PUT", { key, value })
  toast("Saved user note: " + key)
  document.getElementById("um-key-input").value = ""
  document.getElementById("um-value-input").value = ""
  loadUserMemory()
}

async function forgetUserMemory(key) {
  await api("/user-memory/" + encodeURIComponent(key), "DELETE")
  toast("Removed user note: " + key)
  loadUserMemory()
}

// =========================================================================
// Goal synthesis + set (Goals page hero actions)
// =========================================================================
async function synthesizeGoal() {
  toast("Synthesizing goal from capabilities…")
  try {
    const res = await api("/goal/synthesize", "POST")
    if (res && res.goal) {
      toast("Synthesized: " + res.goal.slice(0, 60) + "…")
      refreshStatus()
    } else {
      toast("No goal synthesized", "error")
    }
  } catch (e) {
    toast("Synthesize failed: " + e.message, "error")
  }
}

// =========================================================================
// Settings page — render config into the grid
// =========================================================================
async function loadSettings() {
  try {
    const cfg = await api("/config")
    const grid = document.getElementById("settings-grid")
    if (!grid) return
    const fields = [
      ["Goal", cfg.goal],
      ["Max steps / run", cfg.maxSteps],
      ["Token budget", cfg.tokenBudget],
      ["Tokens used", cfg.tokensUsed],
      ["LLM provider", cfg.llmProvider],
      ["LLM model", cfg.llmModel],
      ["Endpoint", cfg.customProviderUrl],
    ]
    grid.innerHTML = fields
      .map(
        ([k, v]) => `
        <div class="kv">
          <div class="k">${md.escapeHtml(k)}</div>
          <div class="v">${md.escapeHtml(String(v ?? "—"))}</div>
        </div>
      `,
      )
      .join("")
  } catch (e) {
    /* ignore */
  }
}

// =========================================================================
// Search — filters whatever page is active (basic MVP behavior)
// =========================================================================
function onSearch(q) {
  const query = (q || "").toLowerCase()
  const page = document.getElementById("page-" + activePage)
  if (!page) return
  // Find rows/cards inside the active page and toggle visibility by match
  page.querySelectorAll("tr, .summary-card, .kjob, .memory-row, .ev").forEach(el => {
    if (!query) {
      el.style.display = ""
      return
    }
    const text = (el.textContent || "").toLowerCase()
    el.style.display = text.indexOf(query) >= 0 ? "" : "none"
  })
}

// =========================================================================
// dashboard.js — job-application platform control panel (v4)
// =========================================================================
// Pages: Overview / Jobs / Traces / Logs / Memory / Settings.
//   Overview — bar chart of token-spend-per-day + recent runs + live activity
//              + notifications dropdown (topbar bell).
//   Jobs     — horizontal-scroll Kanban, click a card → Sheet showing the
//              full listing + cover letters + follow-ups + traces that led to
//              its discovery (filtered from trace_events by tool_call
//              discover_jobs for this run).
//   Traces   — table of end-to-end runs → Sheet with the hierarchical span
//              tree (prompt → reasoning → text → tool calls → results → usage).
//   Logs     — flat request log of every model request, tool call, and error.
//   Memory   — operator notes (high-authority prompt layer) + agent memory.
// =========================================================================

// State
let TOKEN = localStorage.getItem("agent-harness-token") || ""
let refreshInterval = null
let activeTab = "overview"
let activePage = "overview"
let sidebarCollapsed = false
let livePollInterval = null
let lastLiveSeq = 0
let currentLiveRunId = null

// Notifications
let notifOpen = false
let lastNotifId = 0

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
  // Lazy pre-fill: each modal that needs values loaded from the API names its
  // loader in the MODAL_LOADERS map. Keeps showModal() generic.
  const loader = MODAL_LOADERS[id]
  if (typeof loader === "function") loader()
}
// Modals that pre-fill themselves from the API on open. Add an entry per modal
// that has inputs; keep it opt-in so showModal stays cheap for static modals.
const MODAL_LOADERS = {
  "goal-modal": loadGoalModal,
  "profile-modal": loadProfile,
}
function hideModal(id) {
  document.getElementById(id).style.display = "none"
}

// Legacy tab switcher (still defined for back-compat; the v4 panel uses goPage).
function switchTab(tab, ev) {
  activeTab = tab
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"))
  if (ev && ev.target) ev.target.classList.add("active")
}

// =========================================================================
// Status refresh — populates stat cards + status badge + live poll trigger
// =========================================================================
async function refreshStatus() {
  try {
    const status = await api("/status")

    const sb = document.getElementById("status-badge")
    if (sb) {
      sb.textContent = status.status.toUpperCase()
      sb.className = "status-badge status-" + status.status
    }

    const gs = document.getElementById("stat-goal-status")
    if (gs) gs.textContent = status.status

    const stepEl = document.getElementById("stat-step")
    if (stepEl) stepEl.textContent = status.currentStep
    const maxEl = document.getElementById("stat-max")
    if (maxEl) maxEl.textContent = "of " + (status.maxSteps ?? 100)

    // Last run
    if (status.lastRunAt) {
      const d = new Date(status.lastRunAt)
      const lr = document.getElementById("stat-last-run")
      if (lr)
        lr.textContent =
          "Last run " +
          d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
    } else {
      const lr = document.getElementById("stat-last-run")
      if (lr) lr.textContent = "No runs yet"
    }

    const goalEl = document.getElementById("goal-text")
    if (goalEl) goalEl.textContent = status.goal || "(no goal set)"

    const runLabel = document.getElementById("run-id-label")
    if (status.status === "running" && status.runId) {
      if (runLabel) runLabel.textContent = status.runId.slice(0, 16)
      currentLiveRunId = status.runId
      startLivePoll(status.runId)
    } else {
      if (runLabel) runLabel.textContent = status.status + " — no active run"
    }

    if (activePage === "traces") loadRunsTable().catch(() => {})
    if (activePage === "logs") loadLog().catch(() => {})

    // New: per-turn output token stats (drives the dedicated card)
    loadTurnTokens().catch(() => {})
    // New: notifications badge
    loadNotificationsBadge().catch(() => {})
  } catch (e) {
    console.error("Status refresh failed:", e)
  }
}

// =========================================================================
// Per-turn output tokens — the new Overview KPI for token spend.
// We surface last-turn / max-turn / mean-turn output tokens, NOT the
// application-wide running total.
// =========================================================================
async function loadTurnTokens() {
  try {
    const s = await api("/turn-tokens")
    const el = document.getElementById("stat-output-turn")
    const sub = document.getElementById("stat-output-turn-sub")
    if (!el) return
    if (s.lastTurn == null) {
      el.textContent = "—"
      if (sub) sub.textContent = "no turns yet"
      return
    }
    el.textContent = s.lastTurn.toLocaleString()
    if (sub) {
      const bits = []
      if (s.maxTurn != null) bits.push("max " + s.maxTurn.toLocaleString())
      if (s.meanTurn != null) bits.push("avg " + s.meanTurn.toLocaleString())
      bits.push(s.turns + (s.turns === 1 ? " turn" : " turns"))
      sub.textContent = bits.join(" · ")
    }
  } catch (_) {}
}

// =========================================================================
// Token spend bar chart — tokens-per-day, stacked by component.
// =========================================================================
const BAR_COLORS = {
  in: "var(--accent)",
  out: "var(--ok)",
  reasoning: "var(--warn)",
}

async function refreshBarsFromApi() {
  const wrap = document.getElementById("bars-chart")
  const axis = document.getElementById("bars-axis")
  if (!wrap) return
  try {
    const rows = await api("/tokens-by-day?days=14")
    if (!Array.isArray(rows) || rows.length === 0) {
      wrap.className = "bars-empty"
      wrap.innerHTML = "No token data yet."
      if (axis) axis.innerHTML = ""
      return
    }
    const max = Math.max(
      1,
      ...rows.map(
        r => (r.inTokens || 0) + (r.outTokens || 0) + (r.reasoningTokens || 0),
      ),
    )
    const today = new Date().toISOString().slice(0, 10)
    const fmtDay = day => {
      const dd = day.slice(8, 10)
      const mm = day.slice(5, 7)
      return dd + "/" + mm
    }
    wrap.className = "bars"
    wrap.innerHTML = rows
      .map(r => {
        const tot =
          (r.inTokens || 0) + (r.outTokens || 0) + (r.reasoningTokens || 0)
        const hPct = (tot / max) * 100
        const segIn = r.inTokens || 0
        const segOut = r.outTokens || 0
        const segR = r.reasoningTokens || 0
        const pct = n => (tot > 0 ? (n / tot) * 100 : 0)
        const isToday = r.day === today
        return (
          '<div class="bar-col' +
          (isToday ? " today" : "") +
          '" title="' +
          r.day +
          ": " +
          tot.toLocaleString() +
          ' tokens">' +
          '<div class="bar-stack" style="height:' +
          hPct +
          '%">' +
          '<div class="seg-in" style="height:' +
          pct(segIn) +
          '%"></div>' +
          '<div class="seg-out" style="height:' +
          pct(segOut) +
          '%"></div>' +
          '<div class="seg-reasoning" style="height:' +
          pct(segR) +
          '%"></div>' +
          "</div>" +
          '<div class="bar-x">' +
          fmtDay(r.day) +
          "</div>" +
          "</div>"
        )
      })
      .join("")
    if (axis) {
      const totalAll = rows.reduce(
        (a, r) =>
          a + (r.inTokens || 0) + (r.outTokens || 0) + (r.reasoningTokens || 0),
        0,
      )
      axis.innerHTML =
        "<span>" +
        rows.length +
        " days</span><span>" +
        totalAll.toLocaleString() +
        " tokens total</span>"
    }
  } catch (_) {
    /* ignore */
  }
}

// =========================================================================
// Notifications — fill the bell dropdown + flash the dot on new items
// =========================================================================
async function loadNotificationsBadge() {
  try {
    const notes = await api("/notifications?limit=12")
    if (!Array.isArray(notes) || notes.length === 0) return
    const newest = notes[0].id
    if (newest > lastNotifId) {
      const dot = document.getElementById("bell-dot")
      if (dot) dot.style.display = "block"
      if (notifOpen) renderNotifications(notes)
    }
  } catch (_) {}
}

async function loadNotificationsIntoDropdown() {
  let notes
  try {
    notes = await api("/notifications?limit=12")
  } catch (e) {
    notes = []
  }
  renderNotifications(notes)
}

// Inline SVG icons per notification kind. Kept tiny + stroke-based so they
// inherit the row's color. Each maps to a severity/kind color in CSS.
const NOTIF_ICONS = {
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  job: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  cover_letter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7"/><path d="M21 3v6h-6"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
}

function renderNotifications(notes) {
  const listEl = document.getElementById("notif-list")
  if (!listEl) return
  if (!Array.isArray(notes) || notes.length === 0) {
    listEl.innerHTML = '<div class="notif-empty">No notifications yet.</div>'
    return
  }
  listEl.innerHTML = notes
    .map(n => {
      const icon = NOTIF_ICONS[n.kind] || NOTIF_ICONS.run
      const sev = n.severity || "normal"
      const isNew = n.id > lastNotifId
      const dataAttr = JSON.stringify(n)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
      // Run badge: short run id + step, when present.
      const runBadge =
        n.runId || n.step != null
          ? '<div class="notif-meta">' +
            (n.runId
              ? '<span class="notif-run">' +
                md.escapeHtml(String(n.runId).slice(0, 14)) +
                "</span>"
              : "") +
            (n.step != null
              ? '<span class="notif-step">step ' + n.step + "</span>"
              : "") +
            "</div>"
          : ""
      return (
        '<div class="notif-row sev-' +
        sev +
        (isNew ? " notif-unread" : "") +
        '" onclick="onNotifClick(' +
        dataAttr +
        ')">' +
        '<span class="notif-icon kind-' +
        n.kind +
        '">' +
        icon +
        "</span>" +
        '<div class="notif-body">' +
        '<div class="notif-title-line">' +
        md.escapeHtml(n.title) +
        "</div>" +
        (n.detail
          ? '<div class="notif-detail">' + md.escapeHtml(n.detail) + "</div>"
          : "") +
        runBadge +
        '<div class="notif-when">' +
        relTime(n.createdAt) +
        "</div>" +
        "</div></div>"
      )
    })
    .join("")
  // remember the newest id so we don't re-flag-read items
  lastNotifId = Math.max(lastNotifId, notes[0].id)
}

// Relative time ("2m ago", "just now") with an absolute tooltip. Falls back to
// a formatted date for older items.
function relTime(iso) {
  if (!iso) return ""
  const d = new Date(iso.replace(" ", "T") + "Z")
  const t = d.getTime()
  if (isNaN(t)) return ""
  const s = (Date.now() - t) / 1000
  const abs = d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  let rel
  if (s < 45) rel = "just now"
  else if (s < 90) rel = "1m ago"
  else if (s < 3600) rel = Math.round(s / 60) + "m ago"
  else if (s < 7200) rel = "1h ago"
  else if (s < 86400) rel = Math.round(s / 3600) + "h ago"
  else if (s < 172800) rel = "1d ago"
  else rel = Math.round(s / 86400) + "d ago"
  return '<span title="' + md.escapeHtml(abs) + '">' + rel + "</span>"
}

function toggleNotifications(ev) {
  if (ev) ev.stopPropagation()
  notifOpen = !notifOpen
  const dd = document.getElementById("notif-dropdown")
  const bell = document.querySelector(".bell")
  if (!dd) return
  if (notifOpen) {
    dd.classList.add("open")
    if (bell) bell.setAttribute("aria-expanded", "true")
    loadNotificationsIntoDropdown()
  } else {
    dd.classList.remove("open")
    if (bell) bell.setAttribute("aria-expanded", "false")
  }
}

function markNotificationsRead() {
  const dot = document.getElementById("bell-dot")
  if (dot) dot.style.display = "none"
}

// Mobile off-canvas nav drawer toggle (hamburger). Closes on backdrop click
// too — see the document-level click handler further down.
function toggleNav() {
  const app = document.getElementById("dashboard")
  const toggle = document.querySelector(".nav-toggle")
  if (!app) return
  const open = !app.classList.contains("nav-open")
  app.classList.toggle("nav-open", open)
  if (toggle) toggle.setAttribute("aria-expanded", String(open))
}

function closeNav() {
  const app = document.getElementById("dashboard")
  if (!app) return
  app.classList.remove("nav-open")
  const toggle = document.querySelector(".nav-toggle")
  if (toggle) toggle.setAttribute("aria-expanded", "false")
}

function onNotifClick(n) {
  // Close the dropdown, then navigate. Prefer the deep-link to the exact run's
  // transcript when a runId is present; otherwise land on the most relevant page.
  toggleNotifications(new Event("click"))
  if (!n) return
  // Use window.navigate() (spa-nav.js) so we don't tear down the dashboard.
  // Falls back to a hard navigation if spa-nav isn't loaded for any reason.
  const nav = window.navigate || ((u) => (window.location.href = u))
  if (n.runId) {
    nav("/traces/" + encodeURIComponent(n.runId))
    return
  }
  if (n.kind === "job" || n.kind === "cover_letter") nav("/jobs")
  else if (n.kind === "error") nav("/logs")
  else if (n.kind === "run") nav("/traces")
  else nav("/")
}

// Click-away for the dropdown
document.addEventListener("click", e => {
  if (!notifOpen) return
  const wrap = document.getElementById("bell-wrap")
  if (wrap && !wrap.contains(e.target)) {
    notifOpen = false
    const dd = document.getElementById("notif-dropdown")
    if (dd) dd.classList.remove("open")
    const bell = document.querySelector(".bell")
    if (bell) bell.setAttribute("aria-expanded", "false")
  }
  // Close the mobile nav drawer when clicking the backdrop
  const app = document.getElementById("dashboard")
  if (app && app.classList.contains("nav-open")) {
    if (
      e.target instanceof HTMLElement &&
      e.target.classList.contains("sb-backdrop")
    ) {
      closeNav()
    }
  }
})

// Escape closes any open overlay (nav drawer, notification dropdown, sheet)
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return
  if (notifOpen) {
    toggleNotifications(new Event("click"))
  } else if (
    document.getElementById("dashboard")?.classList.contains("nav-open")
  ) {
    closeNav()
  } else {
    const sheet = document.getElementById("sheet")
    if (sheet && sheet.style.display === "flex") closeSheet()
  }
})

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

// =========================================================================
// Legacy trace picker (kept for back-compat — page hidden in JSX)
// =========================================================================
async function loadTraceRuns() {
  try {
    const runs = await api("/runs?limit=20")
    const sel = document.getElementById("trace-run-select")
    if (!sel) return
    if (!Array.isArray(runs) || runs.length === 0) {
      sel.innerHTML = '<option value="">(no runs yet)</option>'
      return
    }
    sel.innerHTML = runs
      .map(
        r =>
          "<option value=" +
          JSON.stringify(r.runId) +
          ">" +
          md.escapeHtml(r.runId.slice(0, 12) + " · " + r.steps + " steps") +
          "</option>",
      )
      .join("")
  } catch (_) {}
}

async function loadTrace() {
  // Legacy hidden trace-list path; no-op in v4 (sheet is the canonical view)
}

// =========================================================================
// Controls
// =========================================================================
async function startRun() {
  // Optimistic UI: flip the badge + run label to RUNNING immediately so the
  // Run button feels responsive. /api/start blocks until the entire run loop
  // finishes (Durable Objects serialize their request queue — the loop
  // holds the DO's single execution slot for its whole duration, so we
  // can't background it on the same DO without crashing). Fire-and-forget
  // the POST and let the periodic poller pick up state changes.
  const sb = document.getElementById("status-badge")
  if (sb) {
    sb.textContent = "RUNNING"
    sb.className = "status-badge status-running"
  }
  const runLabel = document.getElementById("run-id-label")
  if (runLabel) runLabel.textContent = "starting…"
  const gs = document.getElementById("stat-goal-status")
  if (gs) gs.textContent = "running"

  // Don't await: this resolves when the run completes (minutes away).
  // Surface errors via a toast only on failure — the periodic poller handles
  // status transitions on the success path.
  api("/start", "POST")
    .then(res => {
      toast(res.message)
      refreshStatus()
    })
    .catch(e => {
      toast("Failed to start: " + e.message, "error")
      // Revert the optimistic badge so the UI doesn't lie about state.
      refreshStatus()
    })
}

async function pauseRun() {
  // Optimistic UI — same pattern as startRun(). /api/pause is already fast,
  // but flipping the badge immediately keeps the Run/Pause pair consistent.
  const sb = document.getElementById("status-badge")
  if (sb) {
    sb.textContent = "PAUSED"
    sb.className = "status-badge status-paused"
  }
  try {
    const res = await api("/pause", "POST")
    toast(res.message)
    refreshStatus()
  } catch (e) {
    toast("Failed to pause: " + e.message, "error")
    refreshStatus()
  }
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
  // Model override fields — only sent if the operator filled one in. Blank
  // values are skipped so they fall back to llm-config.json.
  const provider = document.getElementById("llm-provider-input")?.value?.trim()
  const model = document.getElementById("llm-model-input")?.value?.trim()
  const url = document
    .getElementById("custom-provider-url-input")
    ?.value?.trim()
  if (provider) config.llmProvider = provider
  if (model) config.llmModel = model
  if (url) config.customProviderUrl = url
  const res = await api("/config", "PUT", config)
  toast(res.message)
  hideModal("goal-modal")
  refreshStatus()
}

// Pre-fill the goal + model modal from the live config so the operator can
// see (and edit) the current values rather than starting blank. Called from
// showModal() when the goal modal opens.
async function loadGoalModal() {
  try {
    const config = await api("/config")
    const setVal = (id, v) => {
      const el = document.getElementById(id)
      if (el && v != null) el.value = v
    }
    setVal("goal-input", config.goal)
    setVal("max-steps-input", config.maxSteps)
    setVal("budget-input", config.tokenBudget)
    setVal("llm-provider-input", config.llmProvider)
    setVal("llm-model-input", config.llmModel)
    setVal("custom-provider-url-input", config.customProviderUrl)
  } catch (_) {
    // leave the modal blank on failure
  }
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
    ? "Today " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

function scheduleRow(s) {
  const next = s.enabled ? timeFmt(s.nextFireAt) : null
  return (
    '<div class="row-flex">' +
    '<div class="row-main">' +
    '<code class="cron">' +
    md.escapeHtml(s.cron) +
    "</code>" +
    '<span class="focus">(' +
    md.escapeHtml(s.focus) +
    ")</span>" +
    (s.description
      ? '<div class="row-sub">' + md.escapeHtml(s.description) + "</div>"
      : "") +
    (next ? '<div class="row-meta">Next: ' + next + " UTC</div>" : "") +
    "</div>" +
    '<div class="row-actions">' +
    '<span class="pill ' +
    (s.enabled ? "pill-on" : "pill-off") +
    '">' +
    (s.enabled ? "ON" : "OFF") +
    "</span>" +
    '<button class="small secondary" onclick="toggleSchedule(' +
    s.id +
    ", " +
    !s.enabled +
    ')">' +
    (s.enabled ? "Disable" : "Enable") +
    "</button>" +
    '<button class="small danger" onclick="deleteSchedule(' +
    s.id +
    ')">✕</button>' +
    "</div></div>"
  )
}

async function loadSchedules() {
  try {
    const schedules = await api("/schedules")
    const container = document.getElementById("schedules-list")
    const modalContainer = document.getElementById("schedule-list-modal")

    if (schedules.length === 0) {
      const empty =
        '<div class="empty">No schedules. The agent only runs when you click Run.</div>'
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
// Summaries
// =========================================================================
function parseSummary(raw) {
  const out = { body: raw || "", stopReason: null, tokens: null }
  const m = String(raw).match(
    /\[stop_reason:\s*([^,\]]+),\s*tokens?:\s*(\d+)\]/i,
  )
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
  const sev =
    reason === "finished"
      ? "ok"
      : reason === "max_steps_reached" || reason === "token_budget_reached"
        ? "warn"
        : "alarm"
  return (
    '<span class="chip chip-' + sev + '">' + md.escapeHtml(label) + "</span>"
  )
}

async function loadSummaries() {
  try {
    const summaries = await api("/summaries?limit=5")
    const container = document.getElementById("summaries-list")
    if (!container) return
    if (summaries.length === 0) {
      container.innerHTML =
        '<div class="empty">No runs yet. Start your first run from the topbar.</div>'
      return
    }
    container.innerHTML = summaries
      .map(s => {
        const parsed = parseSummary(s.summary)
        return (
          '<article class="summary-card">' +
          '<div class="summary-head">' +
          '<span class="summary-date">' +
          md.escapeHtml(s.date) +
          "</span>" +
          '<div class="summary-meta">' +
          stopReasonChip(parsed.stopReason) +
          '<span class="chip chip-neutral">' +
          s.stepsTaken +
          " steps</span>" +
          (parsed.tokens != null
            ? '<span class="chip chip-neutral">' +
              parsed.tokens.toLocaleString() +
              " tok</span>"
            : "") +
          "</div></div>" +
          '<div class="md-body">' +
          md.render(parsed.body) +
          "</div></article>"
        )
      })
      .join("")
  } catch (e) {
    console.error("Summaries load failed:", e)
  }
}

// =========================================================================
// Pipeline (Kanban — horizontal-scroll board)
// =========================================================================
const PIPELINE_COLUMNS = [
  { key: "discovered", label: "Discovered", color: "var(--ink-3)" },
  { key: "draft", label: "Draft", color: "var(--warn)" },
  { key: "applied", label: "Applied", color: "var(--accent)" },
  { key: "interview", label: "Interview", color: "#a78bfa" },
  { key: "offer", label: "Offer", color: "var(--ok)" },
  { key: "rejected", label: "Rejected", color: "var(--danger)" },
]

async function loadPipeline() {
  try {
    const data = await api("/pipeline")
    const jobsEl = document.getElementById("stat-jobs")
    if (jobsEl) jobsEl.textContent = data.stats.total

    let html = ""
    for (const col of PIPELINE_COLUMNS) {
      const jobs = data.listings.filter(j => j.status === col.key)
      html +=
        '<div class="kanban-column" data-status="' +
        col.key +
        '">' +
        '<div class="kanban-header" style="color:' +
        col.color +
        '">' +
        "<span>" +
        col.label.toUpperCase() +
        "</span>" +
        '<span class="kanban-count">' +
        jobs.length +
        "</span>" +
        "</div>" +
        '<div class="kanban-cards">'
      if (jobs.length === 0) {
        html += '<div class="kanban-empty">Empty</div>'
      } else {
        for (const j of jobs) {
          const safe = JSON.stringify(j)
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
          const score =
            j.matchScore != null
              ? '<span class="badge-score">' +
                Math.round(j.matchScore * 100) +
                "%</span>"
              : ""
          const src =
            '<span class="badge-src">' +
            (j.source === "auto-discovered" ? "AUTO" : "MANUAL") +
            "</span>"
          html +=
            '<div class="kanban-card" draggable="true" data-job-id="' +
            j.id +
            '" onclick="openJobSheet(' +
            j.id +
            ')">' +
            '<div class="company">' +
            md.escapeHtml(j.company) +
            "</div>" +
            '<div class="title">' +
            md.escapeHtml(j.title) +
            "</div>" +
            '<div class="match">' +
            score +
            src +
            "</div></div>"
        }
      }
      html += "</div></div>"
    }
    const board = document.getElementById("kanban-board")
    board.innerHTML = html
    wireKanbanDnD(board)
  } catch (e) {
    console.error("Pipeline load failed:", e)
  }
}

// =========================================================================
// Kanban drag-and-drop — move a job between columns by dragging its card.
// =========================================================================
// Native HTML5 DnD (no library). A card sets dataTransfer on dragstart; the
// target column highlights on dragover and fires the PUT on drop. If the API
// call fails the next loadPipeline() refresh discards the local reordering.
let _draggedJobId = null

function wireKanbanDnD(board) {
  if (!board) return
  // dragstart on cards — remember which job we're dragging.
  board.querySelectorAll(".kanban-card").forEach(card => {
    card.addEventListener("dragstart", e => {
      _draggedJobId = card.getAttribute("data-job-id")
      card.classList.add("dragging")
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
        // Firefox requires setData to actually start the drag.
        try {
          e.dataTransfer.setData("text/plain", _draggedJobId)
        } catch (_) {}
      }
    })
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging")
      _draggedJobId = null
      // Clear any lingering drop-target highlight.
      board
        .querySelectorAll(".kanban-column.drop-target")
        .forEach(c => c.classList.remove("drop-target"))
    })
  })
  // dragover + drop on columns.
  board.querySelectorAll(".kanban-column").forEach(col => {
    col.addEventListener("dragover", e => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      col.classList.add("drop-target")
    })
    col.addEventListener("dragleave", () => {
      col.classList.remove("drop-target")
    })
    col.addEventListener("drop", async e => {
      e.preventDefault()
      col.classList.remove("drop-target")
      const jobId = _draggedJobId
      const newStatus = col.getAttribute("data-status")
      if (!jobId || !newStatus) return
      await moveJobStageDrag(jobId, newStatus)
    })
  })
}

async function moveJobStageDrag(jobId, newStatus) {
  try {
    await api("/jobs/" + jobId + "/status", "PUT", { status: newStatus })
    toast("Moved #" + jobId + " → " + newStatus)
    loadPipeline()
  } catch (e) {
    toast("Move failed: " + (e?.message || e))
    loadPipeline() // refresh to discard the local reordering
  }
}

async function loadPipelineMini() {
  try {
    const data = await api("/pipeline")
    const total = data.stats?.total ?? 0
    const jobsEl = document.getElementById("stat-jobs")
    if (jobsEl) jobsEl.textContent = total
  } catch (_) {}
}

// =========================================================================
// Job detail Sheet — full listing + cover letters + follow-ups + traces
// =========================================================================
async function openJobSheet(jobId) {
  openSheet("Job #" + jobId, true)
  const body = document.getElementById("sheet-body")
  body.innerHTML = '<div class="empty">Loading job…</div>'
  try {
    const data = await api("/jobs/" + jobId)
    if (!data.listing) {
      body.innerHTML = '<div class="empty">Job not found.</div>'
      return
    }
    const j = data.listing
    const chips = []
    chips.push(
      '<span class="job-detail-chip status-chip">' +
        md.escapeHtml(j.status) +
        "</span>",
    )
    if (j.matchScore != null)
      chips.push(
        '<span class="job-detail-chip">match ' +
          Math.round(j.matchScore * 100) +
          "%</span>",
      )
    chips.push(
      '<span class="job-detail-chip">' + md.escapeHtml(j.source) + "</span>",
    )
    if (j.url)
      chips.push(
        '<a class="job-detail-chip" href="' +
          md.escapeHtml(j.url) +
          '" target="_blank" rel="noopener">link ↗</a>',
      )

    let html =
      '<div class="job-detail-head">' +
      '<div class="job-detail-company">' +
      md.escapeHtml(j.company) +
      "</div>" +
      '<div class="job-detail-title">' +
      md.escapeHtml(j.title) +
      "</div>" +
      '<div class="job-detail-meta">' +
      chips.join("") +
      "</div></div>"

    if (j.description) {
      html +=
        '<div class="job-section"><h4>Description</h4><div class="job-desc">' +
        md.escapeHtml(j.description) +
        "</div></div>"
    }
    if (j.notes) {
      html +=
        '<div class="job-section"><h4>Notes</h4><div class="job-desc">' +
        md.escapeHtml(j.notes) +
        "</div></div>"
    }

    // Cover letters
    if (Array.isArray(data.coverLetters) && data.coverLetters.length > 0) {
      html += '<div class="job-section"><h4>Cover letters</h4>'
      for (const cl of data.coverLetters) {
        html +=
          '<div class="job-cl"><div class="job-cl-meta">v' +
          cl.version +
          " · " +
          new Date(cl.createdAt).toLocaleString() +
          "</div><div class='job-cl-body'>" +
          md.escapeHtml(cl.content) +
          "</div></div>"
      }
      html += "</div>"
    }

    // Follow-ups
    if (Array.isArray(data.followUps) && data.followUps.length > 0) {
      html += '<div class="job-section"><h4>Follow-ups</h4>'
      for (const fu of data.followUps) {
        html +=
          '<div class="job-cl"><div class="job-cl-meta">due ' +
          md.escapeHtml(fu.dueDate) +
          (fu.completed ? " · done" : " · open") +
          "</div><div class='job-cl-body'>" +
          md.escapeHtml(fu.note || "—") +
          "</div></div>"
      }
      html += "</div>"
    }

    // Actions: move stage / draft cover letter
    const stageOptions = PIPELINE_COLUMNS.map(
      c =>
        '<option value="' +
        c.key +
        '"' +
        (c.key === j.status ? " selected" : "") +
        ">" +
        c.label +
        "</option>",
    ).join("")
    html +=
      '<div class="job-actions">' +
      '<select id="job-stage-select" style="padding:6px 10px;">' +
      stageOptions +
      "</select>" +
      '<button class="btn sm ghost" onclick="moveJobStage(' +
      jobId +
      ')">Move</button>' +
      '<button class="btn sm ghost" onclick="draftCoverLetter(' +
      jobId +
      ')">Draft cover letter</button>' +
      "</div>"

    html +=
      '<div class="job-section"><h4>Traces that touched this job</h4>' +
      '<div class="empty" id="job-trace-area">Loading traces…</div></div>'

    body.innerHTML = html

    // Now find any trace_events whose payload mentions this job's id / company
    loadTracesForJob(jobId, j)
  } catch (e) {
    body.innerHTML =
      '<div class="empty">Failed to load: ' +
      md.escapeHtml(e.message) +
      "</div>"
  }
}

async function loadTracesForJob(jobId, j) {
  const area = document.getElementById("job-trace-area")
  if (!area) return
  try {
    const noteEvents = []
    // Scan recent trace_events for any that reference this job.
    const events = await api("/trace-events?limit=200")
    if (!Array.isArray(events)) {
      area.textContent = "No trace events found."
      return
    }
    const needle = String(jobId)
    const company = (j.company || "").toLowerCase()
    const title = (j.title || "").toLowerCase()
    for (const ev of events) {
      const hay = (ev.payload || "") + " " + (ev.label || "")
      const hl = hay.toLowerCase()
      if (
        hay.includes(needle) ||
        (company && hl.includes(company)) ||
        (title && hl.includes(title))
      ) {
        noteEvents.push(ev)
      }
    }
    if (noteEvents.length === 0) {
      area.textContent = "No traces mention this job yet."
      return
    }
    area.className = "span-tree"
    area.innerHTML = noteEvents.slice(0, 30).map(renderEvent).join("")
  } catch (_) {
    area.textContent = "Failed to load traces."
  }
}

async function moveJobStage(jobId) {
  const sel = document.getElementById("job-stage-select")
  if (!sel) return
  const status = sel.value
  await api("/jobs/" + jobId + "/status", "PUT", { status })
  toast("Moved to " + status)
  loadPipeline()
  openJobSheet(jobId)
}

async function draftCoverLetter(jobId) {
  toast("Generating cover letter…")
  try {
    const res = await api("/jobs/" + jobId + "/cover-letter", "POST")
    document.getElementById("cover-letter-content").innerHTML = md.render(
      res.coverLetter,
    )
    showModal("cover-letter-modal")
    openJobSheet(jobId) // refresh so the new letter shows
  } catch (e) {
    toast("Failed: " + e.message, "error")
  }
}

// legacy alias some old call sites may invoke
async function showJobActions(jobId) {
  openJobSheet(jobId)
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
              t =>
                '<div class="topic-item"><div class="topic-title">' +
                md.escapeHtml(t.topic) +
                "</div><div class='topic-meta'>Researched " +
                t.timesResearched +
                "x · " +
                (t.lastResearched
                  ? new Date(t.lastResearched).toLocaleDateString()
                  : "never") +
                "</div></div>",
            )
            .join("")
    const findingsHtml =
      data.findings.length === 0
        ? '<div class="empty">No findings yet.</div>'
        : data.findings
            .map(
              f =>
                '<article class="finding-card"><div class="finding-topic">' +
                md.escapeHtml(f.topic) +
                '</div><div class="md-body md-body-tight">' +
                md.render(f.summary) +
                "</div><div class='finding-date'>" +
                new Date(f.createdAt).toLocaleString() +
                "</div></article>",
            )
            .join("")
    const tEl = document.getElementById("topics-list")
    const fEl = document.getElementById("findings-list")
    if (tEl) tEl.innerHTML = topicsHtml
    if (fEl) fEl.innerHTML = findingsHtml
  } catch (_) {}
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
// Manual job add
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
  ;["job-company", "job-title", "job-description", "job-url"].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.value = ""
  })
  loadPipeline()
}

// =========================================================================
// Profile
// =========================================================================
async function loadProfile() {
  try {
    const profile = await api("/profile")
    const set = (id, v) => {
      const el = document.getElementById(id)
      if (el && v != null) el.value = v
    }
    set("profile-cv", profile.cv)
    set("profile-roles", profile.targetRoles)
    set("profile-locations", profile.targetLocations)
    set("profile-skills", profile.skills)
    set("profile-preferences", profile.preferences)
  } catch (_) {}
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
// CV file upload — populates the textarea from a local file (text formats)
// or POSTs binary formats (PDF/DOCX) to /api/profile/cv for server-side raw
// storage. The server stores whatever bytes it gets and returns them in the
// profile.cv field (the cover-letter writer treats it as opaque text).
// =========================================================================
async function uploadProfileCvFile() {
  const input = document.getElementById("profile-cv-file")
  if (!input || !input.files || input.files.length === 0) {
    toast("Choose a file first")
    return
  }
  const file = input.files[0]
  const name = (file.name || "").toLowerCase()
  const isTextLike =
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".rtf") ||
    name.endsWith(".html")
  const ta = document.getElementById("profile-cv")
  try {
    if (isTextLike) {
      // Read inline — fast, no round-trip. Populates the textarea so the
      // operator can edit before saving.
      const text = await file.text()
      ta.value = text
      toast(
        "Loaded " +
          file.name +
          " (" +
          text.length +
          " chars) — review then Save",
      )
    } else {
      // Binary (PDF/DOCX/etc.) — upload raw. Client-side parsing would pull a
      // heavy dependency; server stores the bytes as-is and the LLM handles
      // the format at cover-letter time.
      toast("Uploading " + file.name + "…")
      const bytes = await file.arrayBuffer()
      const token = localStorage.getItem("dashboard_token") || ""
      const res = await fetch(
        "/api/profile/cv?filename=" + encodeURIComponent(file.name),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": file.type || "application/octet-stream",
          },
          body: bytes,
        },
      )
      if (!res.ok) throw new Error("Upload failed: " + res.status)
      const data = await res.json()
      ta.value = data.cv || ""
      toast("Uploaded " + file.name)
    }
  } catch (e) {
    toast("CV load failed: " + (e?.message || e))
  }
}

// =========================================================================
// Memory (agent)
// =========================================================================
let memoryCache = []

async function loadMemory() {
  try {
    const rows = await api("/memory")
    memoryCache = Array.isArray(rows) ? rows : []
    renderMemory()
  } catch (e) {
    const el = document.getElementById("memory-list")
    if (el)
      el.innerHTML =
        '<div class="empty">Memory endpoint unavailable.</div>'
  }
}

function renderMemory() {
  const container = document.getElementById("memory-list")
  if (!container) return
  if (memoryCache.length === 0) {
    container.innerHTML =
      '<div class="empty">No remembered facts. The agent has not called remember yet.</div>'
    return
  }
  container.innerHTML = memoryCache
    .map(
      m =>
        '<div class="memory-row" data-key="' +
        md.escapeHtml(m.key) +
        '"><div class="memory-key"><code>' +
        md.escapeHtml(m.key) +
        '</code></div><div class="memory-value">' +
        md.render(m.value) +
        '</div><button class="small danger" onclick="forgetMemory(\'' +
        md.escapeHtml(m.key).replace(/'/g, "&#39;") +
        "')\">forget</button></div>",
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
// Activity log — flat request log (Logs page)
// =========================================================================
function actionLevel(action) {
  if (!action) return "info"
  if (/error/i.test(action)) return "error"
  if (/warn/i.test(action)) return "warn"
  if (action === "finish" || action === "done") return "ok"
  if (/idle|loop|interrupt/i.test(action)) return "warn"
  return "info"
}
function actionColor(action) {
  const lvl = actionLevel(action)
  if (lvl === "error") return "var(--danger)"
  if (lvl === "warn") return "var(--warn)"
  if (lvl === "ok") return "var(--ok)"
  return "var(--ink-2)"
}

async function loadLog() {
  try {
    const log = await api("/log?limit=50")
    const body = document.getElementById("log-body")
    if (!body) return
    if (log.length === 0) {
      body.innerHTML =
        '<tr><td colspan="7" class="empty">No activity yet.</td></tr>'
      return
    }
    body.innerHTML = log
      .map(
        l => {
          const lvl = actionLevel(l.action)
          return (
            '<tr class="log-row" onclick=\'onLogRowClick(' +
            JSON.stringify(l).replace(/'/g, "&#39;") +
            ')\'>' +
            "<td>" +
            new Date(l.createdAt).toLocaleTimeString() +
            "</td>" +
            '<td class="log-row-cell mono"><code>' +
            md.escapeHtml((l.runId || "").slice(0, 12)) +
            "</code></td>" +
            "<td>" +
            (l.stepNumber ?? "—") +
            "</td>" +
            '<td class="log-row-cell"><span class="lvl lvl-' +
            lvl +
            '">' +
            lvl.toUpperCase() +
            "</span></td>" +
            '<td class="log-row-cell mono">' +
            md.escapeHtml(l.agent || "harness") +
            "</td>" +
            '<td class="action" style="color:' +
            actionColor(l.action) +
            '">' +
            md.escapeHtml(l.action) +
            "</td>" +
            "<td>" +
            (l.tokensUsed != null ? l.tokensUsed.toLocaleString() : "—") +
            "</td></tr>"
          )
        },
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

// =========================================================================
// Init
// =========================================================================
async function init() {
  try {
    await api("/status")
    document.getElementById("auth-screen").style.display = "none"
    document.getElementById("dashboard").style.display = "grid"
    // Detect the active page from the sidebar's aria-current item (the
    // server already marked it). We use this only to fire page-specific
    // live refreshers — navigation is real <a href> clicks now, not JS.
    const active = document.querySelector(".sb-item[aria-current='page']")
    if (active) activePage = active.getAttribute("data-page-id") || activePage
    await Promise.all([refreshStatus(), loadSchedules(), loadProfile()])
    // Each page hydrates its dynamic regions from JSON. The static HTML is
    // already rendered server-side; these fill in the live bits.
    hydrateActivePage()
    if (refreshInterval) clearInterval(refreshInterval)
    refreshInterval = setInterval(() => {
      refreshStatus()
      // Auto-refresh the active page's dynamic content every cycle.
      hydrateActivePage()
    }, 8000)
  } catch (e) {
    if (e.message === "Unauthorized") {
      document.getElementById("auth-screen").style.display = "flex"
      document.getElementById("dashboard").style.display = "none"
    }
  }
}

if (TOKEN) init()

// =========================================================================
// Page hydration — fills in live-updating regions of the active page.
// (No more SPA `goPage()` — the page itself came from the server HTML.)
// Each branch is a no-op if the active page isn't the right one, or if the
// target element isn't on the current page, so this is safe to call anywhere.
// =========================================================================
function hydrateActivePage() {
  // The sidebar item carries data-page-id (set in Layout.tsx) so we know
  // which page we're on without parsing the URL.
  const activeEl = document.querySelector(".sb-item[aria-current='page']")
  const page = activeEl ? activeEl.getAttribute("data-page-id") : null
  if (!page) return
  activePage = page

  if (page === "overview") {
    loadSummaries()
    refreshBarsFromApi()
  }
  if (page === "memory") {
    loadMemory()
    loadUserMemory()
  }
}

function collapseSidebar() {
  sidebarCollapsed = !sidebarCollapsed
  document.getElementById("dashboard").classList.toggle("sidebar-collapsed", sidebarCollapsed)
}

// =========================================================================
// Prefetch — invoked on hover/focus of sidebar links. The browser caches the
// response, so when the user clicks, navigation is instant. Only fetches each
// URL once per session to avoid spamming.
// =========================================================================
const prefetched = new Set()
function prefetch(url) {
  if (prefetched.has(url)) return
  prefetched.add(url)
  // The link uses get + same-origin, so the browser will reuse the cached
  // response for the subsequent navigation click.
  try {
    fetch(url, { credentials: "same-origin" })
  } catch (_) {}
}

// =========================================================================
// Runs table (Traces page)
// =========================================================================
async function loadRunsTable() {
  try {
    const runs = await api("/runs?limit=30")
    const body = document.getElementById("runs-table-body")
    if (!body) return
    if (!Array.isArray(runs) || runs.length === 0) {
      body.innerHTML =
        '<tr><td colspan="7" class="empty">No traces yet. Start a run from the topbar.</td></tr>'
      return
    }
    body.innerHTML = runs
      .map(
        r =>
          '<tr onclick="openTraceSheet(\'' +
          md.escapeHtml(r.runId).replace(/'/g, "&#39;") +
          "')\">" +
          "<td>" +
          new Date(r.createdAt).toLocaleString() +
          "</td>" +
          "<td><code>" +
          md.escapeHtml(r.runId.slice(0, 14)) +
          "</code></td>" +
          "<td>" +
          (r.goal ? md.escapeHtml(r.goal.slice(0, 80)) : "—") +
          "</td>" +
          "<td>" +
          (r.steps ?? 0) +
          "</td>" +
          "<td>" +
          (r.tokens != null ? r.tokens.toLocaleString() : "—") +
          "</td>" +
          "<td>—</td>" +
          '<td><span class="link">Open →</span></td></tr>',
      )
      .join("")
  } catch (_) {}
}

// =========================================================================
// Sheet drawer — renders trace_events for a run as a span tree
// =========================================================================
function openSheet(title, wide) {
  const sheet = document.getElementById("sheet")
  document.getElementById("sheet-title").textContent = title || "Detail"
  document.getElementById("sheet-overlay").style.display = "block"
  if (sheet) {
    sheet.style.display = "flex"
    if (wide) sheet.classList.add("wide")
    else sheet.classList.remove("wide")
  }
  document.body.style.overflow = "hidden"
}

function closeSheet() {
  document.getElementById("sheet-overlay").style.display = "none"
  const sheet = document.getElementById("sheet")
  if (sheet) {
    sheet.style.display = "none"
    sheet.classList.remove("wide")
  }
  document.body.style.overflow = ""
}

async function openTraceSheet(runId) {
  openSheet("Trace — " + runId.slice(0, 14), true)
  const body = document.getElementById("sheet-body")
  body.innerHTML = '<div class="empty">Loading trace…</div>'
  try {
    const events = await api(
      "/runs/" + encodeURIComponent(runId) + "/events?limit=500",
    )
    if (!Array.isArray(events) || events.length === 0) {
      body.innerHTML =
        '<div class="empty">No trace events for this run.</div>'
      return
    }
    // Header: trace-level summary
    const totals = events.reduce(
      (a, e) => {
        a.in += e.tokensIn || 0
        a.out += e.tokensOut || 0
        a.r += e.tokensReasoning || 0
        a.dur += e.durationMs || 0
        return a
      },
      { in: 0, out: 0, r: 0, dur: 0 },
    )
    const summary =
      '<div class="card" style="background:var(--bg-3);padding:14px 16px;margin-bottom:14px;">' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;font-family:var(--font-mono);font-size:11.5px;color:var(--ink-2);">' +
      "<span><b style=\"color:var(--ink)\">" +
      events.length +
      "</b> spans</span>" +
      "<span>prompt <b style=\"color:var(--ink)\">" +
      totals.in.toLocaleString() +
      "</b></span>" +
      "<span>output <b style=\"color:var(--ok)\">" +
      totals.out.toLocaleString() +
      "</b></span>" +
      "<span>reasoning <b style=\"color:var(--warn)\">" +
      totals.r.toLocaleString() +
      "</b></span>" +
      "<span>latency <b style=\"color:var(--ink)\">" +
      (totals.dur / 1000).toFixed(1) +
      "s</b></span>" +
      "</div></div>"
    body.innerHTML =
      summary + '<div class="span-tree">' + events.map(renderEvent).join("") + "</div>"
  } catch (e) {
    body.innerHTML =
      '<div class="empty">Failed to load: ' + md.escapeHtml(e.message) + "</div>"
  }
}

function openLogSheet(stepLogEntry) {
  openSheet("Log detail — step " + stepLogEntry.stepNumber, false)
  const body = document.getElementById("sheet-body")
  const cap = 6000
  body.innerHTML =
    '<div class="ev"><div class="ev-head"><span class="ev-seq">#' +
    stepLogEntry.stepNumber +
    '</span><span class="ev-type ev-type-tool_call">' +
    md.escapeHtml(stepLogEntry.action) +
    "</span><span class='ev-meta'>" +
    new Date(stepLogEntry.createdAt).toLocaleString() +
    '</span></div><div class="ev-body">' +
    '<div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin-bottom:4px;">Input</div>' +
    (stepLogEntry.input
      ? renderJson(stepLogEntry.input, { maxChars: cap })
      : '<span class="empty">—</span>') +
    '<div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin:8px 0 4px;">Output</div>' +
    (stepLogEntry.output
      ? looksLikeJson(stepLogEntry.output)
        ? renderJson(stepLogEntry.output, { maxChars: cap })
        : '<div class="md-body md-body-tight">' + md.render(stepLogEntry.output) + "</div>"
      : '<span class="empty">—</span>') +
    (stepLogEntry.reasoning
      ? '<div style="font-size:11px;color:var(--ink-3);text-transform:uppercase;margin:8px 0 4px;">Reasoning</div><div class="md-body md-body-tight">' +
        md.render(stepLogEntry.reasoning) +
        "</div>"
      : "") +
    "</div></div>"
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
  if (ev.durationMs != null)
    meta += (meta ? " · " : "") + (ev.durationMs / 1000).toFixed(1) + "s"
  if (ev.model) meta += (meta ? " · " : "") + ev.model

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
  } else if (
    ev.eventType === "step_end" ||
    ev.eventType === "run_end" ||
    ev.eventType === "run_start" ||
    ev.eventType === "error"
  ) {
    bodyHtml = ev.payload
      ? "<pre>" + md.escapeHtml(formatMaybeJson(ev.payload)) + "</pre>"
      : '<span class="empty">—</span>'
  } else {
    bodyHtml = ev.payload
      ? "<pre>" + md.escapeHtml(ev.payload) + "</pre>"
      : '<span class="empty">—</span>'
  }

  return (
    '<div class="ev"><div class="ev-head">' +
    '<span class="ev-seq">' +
    ev.seq +
    "</span>" +
    '<span class="ev-type ' +
    typeClass +
    '">' +
    md.escapeHtml(ev.eventType) +
    "</span>" +
    (ev.label
      ? '<span class="ev-label">' + md.escapeHtml(ev.label) + "</span>"
      : "") +
    (ev.stepNumber != null
      ? '<span class="ev-label">step ' + ev.stepNumber + "</span>"
      : "") +
    (meta ? '<span class="ev-meta">' + md.escapeHtml(meta) + "</span>" : "") +
    "</div><div class='ev-body'>" +
    bodyHtml +
    "</div></div>"
  )
}

function formatMaybeJson(s) {
  try {
    const parsed = JSON.parse(s)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return s
  }
}

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
      const events = await api("/trace-events?limit=40")
      const el = document.getElementById("live-events")
      if (!el) return
      if (!Array.isArray(events) || events.length === 0) {
        el.innerHTML = '<div class="empty">No events yet…</div>'
        return
      }
      const recent = events.slice(-15).reverse()
      el.innerHTML = recent
        .map(ev => {
          const payloadPreview = (ev.payload || "")
            .replace(/\s+/g, " ")
            .slice(0, 80)
          return (
            '<div class="live-line" onclick="openTraceSheet(\'' +
            md.escapeHtml(ev.runId).replace(/'/g, "&#39;") +
            "')\">" +
            '<span class="live-seq">' +
            ev.seq +
            "</span>" +
            '<span class="live-type ev-type-' +
            ev.eventType +
            '">' +
            md.escapeHtml(ev.eventType) +
            "</span>" +
            '<span class="live-payload">' +
            md.escapeHtml(
              (ev.label || "") + (payloadPreview ? " · " + payloadPreview : ""),
            ) +
            "</span></div>"
          )
        })
        .join("")
    } catch (_) {}
  }
  tick()
  livePollInterval = setInterval(tick, 3000)
}

function stopLivePoll() {
  if (livePollInterval) clearInterval(livePollInterval)
  livePollInterval = null
}

// =========================================================================
// User memory (operator notes)
// =========================================================================
let userMemoryCache = []

async function loadUserMemory() {
  try {
    const rows = await api("/user-memory")
    userMemoryCache = Array.isArray(rows) ? rows : []
    renderUserMemory()
  } catch (e) {
    const el = document.getElementById("um-list")
    if (el) el.innerHTML = '<div class="empty">/api/user-memory unavailable.</div>'
  }
}

function renderUserMemory() {
  const container = document.getElementById("um-list")
  if (!container) return
  if (userMemoryCache.length === 0) {
    container.innerHTML =
      '<div class="empty">No operator notes yet. Add via the form above.</div>'
    return
  }
  container.innerHTML = userMemoryCache
    .map(
      m =>
        '<div class="memory-row" data-key="' +
        md.escapeHtml(m.key) +
        '"><div class="memory-key"><code>' +
        md.escapeHtml(m.key) +
        '</code></div><div class="memory-value">' +
        md.render(m.value) +
        '</div><button class="small danger" onclick="forgetUserMemory(\'' +
        md.escapeHtml(m.key).replace(/'/g, "&#39;") +
        "')\">remove</button></div>",
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
// Goal synthesis
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
// Settings page
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
        ([k, v]) =>
          '<div class="kv"><div class="k">' +
          md.escapeHtml(k) +
          '</div><div class="v">' +
          md.escapeHtml(String(v ?? "—")) +
          "</div></div>",
      )
      .join("")
  } catch (_) {}
}

// =========================================================================
// Search — filters whatever page is active
// =========================================================================
function onSearch(q) {
  const query = (q || "").toLowerCase()
  const page = document.getElementById("page-" + activePage)
  if (!page) return
  page.querySelectorAll("tr, .summary-card, .kjob, .memory-row, .ev, .kanban-card").forEach(el => {
    if (!query) {
      el.style.display = ""
      return
    }
    const text = (el.textContent || "").toLowerCase()
    el.style.display = text.indexOf(query) >= 0 ? "" : "none"
  })
}

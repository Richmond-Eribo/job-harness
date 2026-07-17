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

// Inline SVG icons used by client-side rendering in this file (e.g. the
// Kanban card delete button rebuilt by loadPipeline()). Kept as raw strings
// so they can be concatenated into HTML — mirrors the lucide icons in
// Layout.tsx without needing to round-trip through the server.
const ICONS_SVG = {
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  sparkles:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
}

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
  "sources-modal": loadJobSources,
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

    // On the traces page, refresh the run list OR the open transcript
    // (whichever is mounted). The transcript page handles its own live poll.
    if (activePage === "traces") {
      if (document.getElementById("page-trace")) {
        // transcript live-poll is driven by loadTranscript; nothing here
      } else {
        loadRunsTable().catch(() => {})
      }
    }
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

// =========================================================================
// Browser capability — the relay panel on Settings. Shows which target is
// connected (live = your Chrome via the extension, managed = headless), and
// the connect instructions when nothing is attached. Polled while on Settings.
// =========================================================================
let browserPollTimer = null

async function loadBrowserStatus() {
  stopBrowserPoll()
  await renderBrowserStatus()
  // Poll every ~5s so the panel reflects the extension connecting/disconnecting.
  browserPollTimer = setInterval(renderBrowserStatus, 5000)
}

function stopBrowserPoll() {
  if (browserPollTimer) {
    clearInterval(browserPollTimer)
    browserPollTimer = null
  }
}

async function renderBrowserStatus() {
  const panel = document.getElementById("browser-panel")
  const pill = document.getElementById("browser-target-pill")
  if (!panel || !pill) return
  let st
  try {
    st = await api("/browser/status")
  } catch (e) {
    panel.innerHTML =
      '<div class="empty">Failed to load browser status: ' +
      md.escapeHtml(e?.message || String(e)) +
      "</div>"
    return
  }
  const target = st.target || "none"
  // Target pill reflects the active target.
  if (target === "live") {
    pill.textContent = "● LIVE (your Chrome)"
    pill.className = "pill pill-on"
  } else if (target === "managed") {
    pill.textContent = "● MANAGED (headless)"
    pill.className = "pill pill-on"
  } else {
    pill.textContent = "○ none"
    pill.className = "pill pill-off"
  }

  if (target === "none") {
    // No browser connected — show the connect instructions.
    const origin = location.origin
    panel.innerHTML =
      '<div class="browser-disconnect-state">' +
      "<p><b>No browser connected.</b> The agent can only browse open sites via " +
      "<code>fetch_page</code> until you connect a target.</p>" +
      '<div class="browser-steps">' +
      "<p class='browser-step-title'>Connect your real Chrome (free-tier, reaches login-walled sites):</p>" +
      "<ol>" +
      "<li>Load the <code>extension/</code> folder at <code>chrome://extensions</code> (Developer mode → Load unpacked).</li>" +
      "<li>Click the extension icon, enter this worker URL: <code>" +
      md.escapeHtml(origin) +
      "</code></li>" +
      "<li>Keep a tab open + focused. The agent uses your logged-in sessions — it never sees or types passwords.</li>" +
      "</ol>" +
      "<p class='browser-step-note'>The extension connects to <code>" +
      md.escapeHtml(origin) +
      "/browser/relay</code>. See <code>docs/browser-cdp-guide.md</code>.</p>" +
      "</div>" +
      "<hr class='browser-hr'/>" +
      "<p class='browser-alt'>Alternatively, enable the managed headless browser (paid Workers plan) by uncommenting the <code>browser</code> binding in <code>wrangler.jsonc</code>.</p>" +
      "</div>"
    return
  }

  // Connected — show details + disconnect (live only).
  const live = st.live || {}
  const rows = []
  if (target === "live") {
    rows.push(["Target", "Your real Chrome (via extension relay)"])
    rows.push([
      "Connected",
      live.connectedAt
        ? new Date(live.connectedAt + "Z").toLocaleString()
        : "—",
    ])
    rows.push(["User agent", live.userAgent || "—"])
  } else {
    rows.push(["Target", "Managed headless Chromium (paid plan)"])
  }
  rows.push(["Pending CDP calls", String(st.pendingCalls ?? 0)])
  if (st.sessionId) rows.push(["Session", String(st.sessionId)])

  panel.innerHTML =
    rows
      .map(
        ([k, v]) =>
          '<div class="kv"><div class="k">' +
          md.escapeHtml(k) +
          '</div><div class="v">' +
          md.escapeHtml(String(v)) +
          "</div></div>",
      )
      .join("") +
    (target === "live"
      ? '<div class="browser-actions"><button class="btn sm danger" onclick="disconnectBrowser()">Disconnect</button></div>'
      : "")
}

async function disconnectBrowser() {
  try {
    await api("/browser/disconnect", "POST")
    toast("Browser disconnected")
    renderBrowserStatus()
  } catch (e) {
    toast("Failed to disconnect: " + (e?.message || String(e)), "error")
  }
}

// Manual test: navigate + observe a URL through the connected browser. This is
// the fastest way to verify the whole chain (relay → extension → Chrome → CDP)
// without a full agent run. No LLM call — free to repeat.
async function probeBrowser() {
  const input = document.getElementById("browser-test-url")
  const btn = document.getElementById("browser-test-btn")
  const out = document.getElementById("browser-test-result")
  if (!input || !out) return
  const url = input.value.trim()
  if (!url) {
    out.innerHTML = '<div class="bt-err">Enter a URL to test.</div>'
    return
  }
  btn.disabled = true
  btn.textContent = "Testing…"
  out.innerHTML = '<div class="bt-pending">Navigating + observing…</div>'
  try {
    const r = await api("/browser/probe", "POST", { url })
    if (r.error && !r.navigated) {
      out.innerHTML =
        '<div class="bt-err">✗ ' + md.escapeHtml(r.error) + "</div>"
      return
    }
    const targetBadge =
      '<span class="bt-target bt-target-' + md.escapeHtml(r.target) + '">' +
      md.escapeHtml(r.target) + "</span>"
    if (r.loginRequired) {
      out.innerHTML =
        '<div class="bt-ok">' + targetBadge + " loaded, but login required</div>" +
        '<div class="bt-detail">' + md.escapeHtml(r.error || "") + "</div>"
      return
    }
    const ok = r.navigated
    out.innerHTML =
      '<div class="' + (ok ? "bt-ok" : "bt-err") + '">' +
      targetBadge +
      (ok ? " ✓ navigated" : " ✗ failed") +
      "</div>" +
      '<div class="bt-meta">' +
      "<b>" + md.escapeHtml(r.title || "(no title)") + "</b> · " +
      md.escapeHtml(r.url) + " · " + (r.elementCount || 0) + " elements" +
      "</div>" +
      (r.error ? '<div class="bt-err">' + md.escapeHtml(r.error) + "</div>" : "") +
      (r.bodyPreview
        ? '<pre class="bt-body">' + md.escapeHtml(r.bodyPreview) + "</pre>"
        : "")
  } catch (e) {
    out.innerHTML =
      '<div class="bt-err">✗ ' + md.escapeHtml(e?.message || String(e)) + "</div>"
  } finally {
    btn.disabled = false
    btn.textContent = "Test"
  }
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
// Same five columns as the server-rendered JobsPage. Kept in sync here so the
// periodic reload after a drag/delete rebuilds the same board shape.
const PIPELINE_COLUMNS = [
  { key: "discovered", label: "Discovered", accent: "var(--text-3)" },
  { key: "draft", label: "Draft", accent: "var(--warn)" },
  { key: "applied", label: "Applied", accent: "var(--amber)" },
  { key: "interview", label: "Interview", accent: "#a78bfa" },
  { key: "offer", label: "Offer", accent: "var(--ok)" },
]

// Card markup mirror of Jobs.tsx, so the hovery delete button and the drag
// handle keep working after a periodic refresh.
function kanbanCardHtml(j) {
  const autoPct = j.matchScore != null ? Math.round(j.matchScore * 100) : null
  const match = autoPct != null
    ? '<span class="kanban-auto">' + autoPct + "% AUTO</span>"
    : '<span class="kanban-auto kanban-auto-manual">MANUAL</span>'
  return (
    '<article class="kanban-card" draggable="true" data-job-id="' +
    j.id +
    '">' +
    '<a class="kanban-card-link" href="/jobs/' +
    j.id +
    '" onclick="event.preventDefault();openJobSheet(' +
    j.id +
    ')">' +
    '<span class="kanban-company">' +
    md.escapeHtml(j.company) +
    "</span>" +
    '<span class="kanban-role">' +
    md.escapeHtml(j.title) +
    "</span>" +
    '<span class="kanban-match">' +
    match +
    "</span>" +
    "</a>" +
    '<button type="button" class="kanban-delete" aria-label="Delete ' +
    md.escapeHtml(j.company + " " + j.title) +
    '" onclick="event.preventDefault();event.stopPropagation();removeJob(' +
    j.id +
    ')">' +
    ICONS_SVG.trash +
    "</button>" +
    "</article>"
  )
}

async function loadPipeline() {
  try {
    const data = await api("/pipeline")
    const jobsEl = document.getElementById("stat-jobs")
    if (jobsEl) jobsEl.textContent = data.stats.total

    let html = ""
    for (const col of PIPELINE_COLUMNS) {
      const jobs = data.listings.filter(j => j.status === col.key)
      html +=
        '<section class="kanban-column" data-status="' +
        col.key +
        '">' +
        '<div class="kanban-header">' +
        '<span class="kanban-title" style="color:' +
        col.accent +
        '">' +
        col.label.toUpperCase() +
        "</span>" +
        '<span class="kanban-count">' +
        jobs.length +
        "</span>" +
        "</div>" +
        '<div class="kanban-cards">'
      if (jobs.length === 0) {
        html += '<p class="kanban-empty">Empty</p>'
      } else {
        for (const j of jobs) html += kanbanCardHtml(j)
      }
      html += "</div></section>"
    }
    const board = document.getElementById("kanban-board")
    if (board) {
      board.innerHTML = html
      wireKanbanDnD(board)
    }
  } catch (e) {
    console.error("Pipeline load failed:", e)
  }
}

// Delete a job from the board. Fires the DELETE endpoint then reloads the
// board so counts and ordering stay correct server-side.
async function removeJob(jobId) {
  try {
    await api("/jobs/" + jobId, "DELETE")
    toast("Removed job #" + jobId)
    loadPipeline()
  } catch (e) {
    toast("Remove failed: " + (e?.message || e), "error")
    loadPipeline()
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
// Overview — inline "add a job" form. Posts to the same /api/jobs endpoint as
// the modal, then refreshes the headline counts + stage breakdown in place so
// the operator sees their new job land without a full page reload.
// =========================================================================
async function submitOverviewJob() {
  const company = (document.getElementById("ov-company") || {}).value
  const title = (document.getElementById("ov-title") || {}).value
  const url = (document.getElementById("ov-url") || {}).value
  const description = (document.getElementById("ov-desc") || {}).value
  const msg = document.getElementById("ov-add-msg")
  const btn = document.querySelector("#ov-add-form .ov-add-btn")
  if (!company || !title) {
    if (msg) {
      msg.textContent = "Company and title are required."
      msg.className = "ov-add-msg err"
    }
    return
  }
  if (btn) {
    btn.disabled = true
    btn.classList.add("loading")
  }
  if (msg) {
    msg.textContent = ""
    msg.className = "ov-add-msg"
  }
  try {
    await api("/jobs", "POST", { company, title, url, description })
    // Clear the form.
    ;["ov-company", "ov-title", "ov-url", "ov-desc"].forEach(id => {
      const el = document.getElementById(id)
      if (el) el.value = ""
    })
    if (msg) {
      msg.textContent = "Added — refresh counts…"
      msg.className = "ov-add-msg ok"
    }
    await refreshOverviewCounts()
    if (msg) {
      msg.textContent = "Added to pipeline ✓"
      setTimeout(() => {
        if (msg) {
          msg.textContent = ""
          msg.className = "ov-add-msg"
        }
      }, 2500)
    }
  } catch (e) {
    if (msg) {
      msg.textContent = "Failed: " + (e?.message || String(e))
      msg.className = "ov-add-msg err"
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.classList.remove("loading")
    }
  }
}

// Re-fetch pipeline stats and update the overview cards in place. Cheaper than
// a full reload — only touches the metric cards + stage bars + total.
async function refreshOverviewCounts() {
  try {
    const pipe = await api("/pipeline")
    const stats = pipe?.stats || {}
    const total = stats.total ?? 0
    const byStatus = stats.byStatus || {}
    const totalEl = document.getElementById("ov-total")
    if (totalEl) totalEl.textContent = String(total)
    const active = ["discovered", "draft", "applied", "interview", "offer"]
      .reduce((s, k) => s + (Number(byStatus[k]) || 0), 0)
    const totalCard = totalEl?.closest(".stat-card")
    if (totalCard) {
      const sub = totalCard.querySelector(".stat-sub")
      if (sub)
        sub.textContent =
          active + " active · " + (Number(byStatus.rejected) || 0) + " rejected"
    }
    const fuEl = document.getElementById("ov-followups")
    if (fuEl) {
      fuEl.textContent = String(stats.dueFollowUps ?? 0)
      fuEl.style.color = stats.dueFollowUps ? "var(--danger)" : ""
      const fuCard = fuEl.closest(".stat-card")
      const fuSub = fuCard?.querySelector(".stat-sub")
      if (fuSub)
        fuSub.textContent = stats.dueFollowUps ? "needs attention" : "nothing due"
    }
    // Re-render stage bars from the fresh byStatus counts.
    const stagesEl = document.getElementById("ov-stages")
    if (stagesEl) {
      const stages = [
        ["discovered", "Discovered", "var(--text-3)"],
        ["draft", "Draft", "var(--warn)"],
        ["applied", "Applied", "var(--amber)"],
        ["interview", "Interview", "#a78bfa"],
        ["offer", "Offer", "var(--ok)"],
      ]
      stagesEl.innerHTML = stages
        .map(([key, label, color]) => {
          const count = Number(byStatus[key]) || 0
          const pct = total > 0 ? (count / total) * 100 : 0
          return (
            '<a class="ov-stage" href="/jobs#' +
            key +
            '" style="--stage:' +
            color +
            '">' +
            '<div class="ov-stage-bar"><div class="ov-stage-fill" style="width:' +
            pct +
            '%"></div></div>' +
            '<div class="ov-stage-label"><span class="ov-stage-name">' +
            label +
            '</span><span class="ov-stage-count">' +
            count +
            "</span></div>" +
            "</a>"
          )
        })
        .join("")
    }
  } catch (_) {
    // non-fatal — counts will refresh on next poll
  }
}

// =========================================================================
// Job sources — operator-configured job websites the agent may browse.
// CRUD backing the "Job sources" modal in the dashboard. The agent's
// search_site / fetch_page tools refuse any URL not on a source here.
// =========================================================================
async function loadJobSources() {
  const list = document.getElementById("sources-list")
  if (!list) return
  try {
    const sources = await api("/job-sources")
    if (!Array.isArray(sources) || sources.length === 0) {
      list.innerHTML =
        '<div class="empty">No sources yet. Add one below — the agent cannot search without at least one.</div>'
      return
    }
    list.innerHTML = sources
      .map(s => {
        const pill = s.enabled
          ? '<span class="pill pill-on">ON</span>'
          : '<span class="pill pill-off">OFF</span>'
        const toggle = s.enabled ? "Disable" : "Enable"
        const esc = md.escapeHtml
        return (
          '<div class="row-flex">' +
          '<div class="row-main">' +
          '<div style="font-weight:600; color:var(--text);">' +
          esc(s.name) +
          " " +
          pill +
          "</div>" +
          '<div style="font-size:11px; color:var(--text-3); margin-top:2px;">' +
          esc(s.baseUrl) +
          "</div>" +
          '<div style="font-size:10.5px; color:var(--text-3); margin-top:2px; font-family:var(--font-mono); word-break: break-all;">' +
          esc(s.searchUrlTemplate) +
          "</div>" +
          "</div>" +
          '<div class="row-actions">' +
          '<button class="small secondary" onclick="toggleJobSource(' +
          s.id +
          ", " +
          !s.enabled +
          ')">' +
          toggle +
          "</button>" +
          '<button class="small danger" onclick="removeJobSource(' +
          s.id +
          ')">✕</button>' +
          "</div></div>"
        )
      })
      .join("")
  } catch (e) {
    list.innerHTML =
      '<div class="empty">Failed to load: ' +
      md.escapeHtml(e?.message || String(e)) +
      "</div>"
  }
}

async function addJobSource() {
  const source = {
    name: document.getElementById("source-name-input").value.trim(),
    baseUrl: document.getElementById("source-base-url-input").value.trim(),
    searchUrlTemplate: document
      .getElementById("source-template-input")
      .value.trim(),
    notes:
      document.getElementById("source-notes-input").value.trim() || undefined,
  }
  if (!source.name || !source.baseUrl || !source.searchUrlTemplate) {
    toast("Name, base URL, and template are required")
    return
  }
  if (!source.searchUrlTemplate.includes("{query}")) {
    toast("Template must contain a {query} placeholder")
    return
  }
  try {
    const res = await api("/job-sources", "POST", source)
    toast(res.message)
    document.getElementById("source-name-input").value = ""
    document.getElementById("source-base-url-input").value = ""
    document.getElementById("source-template-input").value = ""
    document.getElementById("source-notes-input").value = ""
    loadJobSources()
  } catch (e) {
    toast("Add failed: " + (e?.message || e))
  }
}

async function toggleJobSource(id, enable) {
  try {
    await api("/job-sources/" + id, "PUT", { enabled: enable })
    loadJobSources()
  } catch (e) {
    toast("Toggle failed: " + (e?.message || e))
  }
}

async function removeJobSource(id) {
  try {
    const res = await api("/job-sources/" + id, "DELETE")
    toast(res.message)
    loadJobSources()
  } catch (e) {
    toast("Delete failed: " + (e?.message || e))
  }
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
  // Derive the active page from the URL path. The sidebar's aria-current is
  // set by the server on first load and by spa-nav.js on swaps, but reading
  // the path is authoritative and survives DOM swaps without depending on
  // markup staying in sync.
  const page = pathToPage(location.pathname)
  if (!page) return
  activePage = page

  // Stop the transcript live-poll when leaving the trace page.
  if (page !== "traces") stopTranscriptPoll()
  // Stop the browser status poll when leaving settings.
  if (page !== "settings") stopBrowserPoll()

  if (page === "overview") {
    loadSummaries()
    refreshBarsFromApi()
  }
  if (page === "memory") {
    loadMemory()
    loadUserMemory()
  }
  if (page === "settings") {
    loadBrowserStatus()
  }
  // The single-run transcript page. Both it and the run-list page share the
  // "traces" sidebar item, so we distinguish by the #page-trace container.
  if (page === "traces") {
    const traceEl = document.getElementById("page-trace")
    if (traceEl) {
      loadTranscript(traceEl.getAttribute("data-run-id"))
    } else {
      // Fresh tbody after an SPA swap -> allow the delegated click handler
      // to re-wire on the new element.
      runsTableClickWired = false
      wireRunsTableClick()
      loadRunsTable()
    }
  }
}

// Map a URL path to a page id. Mirrors the NAV array in Layout.tsx. /traces/:id
// and /traces both report "traces"; the hydrator distinguishes them by markup.
function pathToPage(path) {
  if (path === "/") return "overview"
  if (path === "/jobs") return "jobs"
  if (path === "/traces" || path.indexOf("/traces/") === 0) return "traces"
  if (path === "/logs") return "logs"
  if (path === "/memory") return "memory"
  if (path === "/settings") return "settings"
  return null
}

// Called by spa-nav.js after the `.main-scroll` region has been swapped in.
// Re-detect the active page from the new URL and hydrate it, so the swapped
// page picks up its live refreshers just like a freshly loaded page would.
window.onSpaNav = function () {
  try {
    hydrateActivePage()
  } catch (_) {}
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
// Runs table (Traces page) — columns match the SSR <thead> in Traces.tsx:
// Started · Run · Status · Steps · Tokens · Goal · [Open]
// =========================================================================
const RUN_STATUS_LABEL = {
  max_steps_reached: "max steps",
  token_budget_reached: "budget",
  idle_detected: "idle",
  repeated_loop_detected: "loop",
  interrupted: "interrupted",
}
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

    // Keyed reconciliation instead of wholesale innerHTML replacement.
    // Reuse existing rows when possible so hover/focus/scroll and any
    // expanded <details> inside a row survive the 8s refresh — and only
    // touch cells whose value actually changed. New runs prepend; runs no
    // longer in the response are removed.
    const existing = new Map()
    for (const tr of Array.from(body.querySelectorAll("tr[data-run-id]"))) {
      existing.set(tr.getAttribute("data-run-id"), tr)
    }
    const seen = new Set()
    let firstChild = body.firstElementChild
    for (const r of runs) {
      const rid = r.runId
      seen.add(rid)
      let tr = existing.get(rid)
      const created = new Date(r.createdAt).toLocaleString()
      const shortId = md.escapeHtml(rid.slice(0, 14))
      const status = r.status
        ? md.escapeHtml(RUN_STATUS_LABEL[r.status] || r.status)
        : "—"
      const steps = String(r.steps ?? 0)
      const tokens = r.tokens != null ? r.tokens.toLocaleString() : "—"
      const goal = r.goal ? md.escapeHtml(r.goal.slice(0, 80)) : "—"
      if (!tr) {
        // Build a new row via a template (avoids inline-event string escaping).
        tr = document.createElement("tr")
        tr.className = "tr-link"
        tr.setAttribute("data-run-id", rid)
        tr.setAttribute("data-href", "/traces/" + rid)
        // Click handling is delegated (wireRunsTableClick) — no per-row
        // listener, so reconciled rows keep their wiring automatically.
        tr.innerHTML =
          '<td class="cell-created"></td>' +
          '<td><code>' +
          shortId +
          "</code></td>" +
          '<td><span class="chip chip-neutral cell-status">' +
          status +
          "</span></td>" +
          '<td class="cell-steps"></td>' +
          '<td class="cell-tokens"></td>' +
          '<td class="ts-goal-cell cell-goal"></td>' +
          '<td><span class="link">Open →</span></td>'
        tr.querySelector(".cell-created").textContent = created
        tr.querySelector(".cell-steps").textContent = steps
        tr.querySelector(".cell-tokens").textContent = tokens
        tr.querySelector(".cell-goal").textContent = goal
      } else {
        // Patch only changed cells. Each row remembers its rendered values
        // via data-* attrs so unchanged cells never get touched.
        setIfChanged(tr, "created", created)
        setIfChanged(tr, "status", status)
        setIfChanged(tr, "steps", steps)
        setIfChanged(tr, "tokens", tokens)
        setIfChanged(tr, "goal", goal)
      }
      // Place rows in response order (newest first). If this row isn't
      // already at the right position, move it.
      if (tr !== firstChild) {
        body.insertBefore(tr, firstChild)
      } else {
        firstChild = firstChild.nextElementSibling
      }
    }
    // Drop rows that vanished from the response.
    for (const [rid, tr] of existing) {
      if (!seen.has(rid)) tr.remove()
    }
  } catch (_) {}
}

// Patch a labelled cell only when its value changed; remember the value in a
// data-* attr so the next poll can skip the write. keeps DOM writes minimal.
function setIfChanged(tr, key, value) {
  const k = "data-" + key
  if (tr.getAttribute(k) === value) return
  const el = tr.querySelector(".cell-" + key)
  if (el) el.textContent = value
  tr.setAttribute(k, value)
}

// Delegated click handler for the runs table. One listener covers both the
// server-rendered rows and rows created/patched by loadRunsTable(). Uses SPA
// navigation (window.navigate) when available, hard nav otherwise.
let runsTableClickWired = false
function wireRunsTableClick() {
  if (runsTableClickWired) return
  const body = document.getElementById("runs-table-body")
  if (!body) return
  runsTableClickWired = true
  body.addEventListener("click", function (e) {
    const tr = e.target.closest && e.target.closest("tr[data-run-id]")
    if (!tr) return
    const rid = tr.getAttribute("data-run-id")
    if (!rid) return
    ;(window.navigate || function (u) {
      window.location.href = u
    })("/traces/" + rid)
  })
}

// =========================================================================
// Transcript (single-run page) — step-grouped, with nested sub-agent events.
// =========================================================================
// Events from /api/runs/:runId are grouped by stepNumber, then each step's
// blocks render in order: SYSTEM PROMPT → MESSAGES SENT → REASONING → TOOL
// CALLS (each paired with its result by toolCallId, with sub-agent activity
// nested underneath via parentId) → TEXT → RESPONSE. Every block carries a
// timestamp + token accounting. While the run is active, this long-polls
// ?sinceSeq=N every ~2.5s and appends new steps.
let transcriptPollTimer = null
let transcriptLastSeq = 0
let transcriptRunId = null
let transcriptRunActive = false

async function loadTranscript(runId) {
  if (!runId) return
  transcriptRunId = runId
  const root = document.getElementById("transcript")
  if (!root) return
  // Only show the "Loading…" placeholder on the FIRST load of this run, when
  // the root has no rendered step cards yet. On later calls (the 8s hydrate
  // loop re-enters here while the page is mounted) we keep the existing DOM
  // so renderTranscript can reconcile in place — otherwise wiping innerHTML
  // here would destroy the banner + step-card cache every cycle, rebuilding
  // the transcript and throwing the user's scroll back to the top.
  const isFirstLoad =
    !root.querySelector("#ts-live-banner") &&
    !root.querySelector("[data-step-key]")
  if (isFirstLoad) {
    root.innerHTML = '<div class="empty">Loading transcript…</div>'
  }
  try {
    const data = await api("/runs/" + encodeURIComponent(runId))
    const events = Array.isArray(data?.events) ? data.events : []
    transcriptLastSeq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0)
    transcriptRunActive = !!(
      data?.run &&
      (data.run.status === null || data.run.status === undefined)
    ) || (events.length > 0 && !events.some(e => e.eventType === "run_end"))
    renderTranscript(root, events, runId)
  } catch (e) {
    root.innerHTML =
      '<div class="empty">Failed to load: ' + md.escapeHtml(e.message) + "</div>"
  }
  startTranscriptPoll()
}

function stopTranscriptPoll() {
  if (transcriptPollTimer) {
    clearInterval(transcriptPollTimer)
    transcriptPollTimer = null
  }
}

function startTranscriptPoll() {
  stopTranscriptPoll()
  // Only poll while the run appears active (no run_end event yet).
  if (!transcriptRunActive || !transcriptRunId) return
  const banner = document.getElementById("ts-live-banner")
  if (banner) banner.style.display = "flex"
  transcriptPollTimer = setInterval(pollTranscript, 2500)
}

async function pollTranscript() {
  if (!transcriptRunId) return
  try {
    const events = await api(
      "/runs/" +
        encodeURIComponent(transcriptRunId) +
        "/events?sinceSeq=" +
        transcriptLastSeq +
        "&limit=500",
    )
    if (!Array.isArray(events) || events.length === 0) return
    for (const e of events) {
      transcriptLastSeq = Math.max(transcriptLastSeq, e.seq || 0)
      if (e.eventType === "run_end") {
        transcriptRunActive = false
        stopTranscriptPoll()
        const banner = document.getElementById("ts-live-banner")
        if (banner) banner.style.display = "none"
      }
    }
    // Re-render the full transcript from the cumulative set. Cheaper than
    // surgically inserting blocks, and correct for grouping/nesting.
    const full = await api(
      "/runs/" + encodeURIComponent(transcriptRunId) + "?_=1",
    )
    const allEvents = Array.isArray(full?.events) ? full.events : []
    renderTranscript(
      document.getElementById("transcript"),
      allEvents,
      transcriptRunId,
    )
    const liveText = document.getElementById("ts-live-text")
    if (liveText && events.length > 0) {
      const last = events[events.length - 1]
      liveText.textContent =
        "running · last: " +
        (last.eventType || "?") +
        (last.label ? " " + last.label : "")
    }
  } catch (_) {
    // transient — keep polling
  }
}

// ── Group events into steps and render ──────────────────────────────────
// Per-step reconciliation: the live banner is created once and never torn
// down, and each step card is only rebuilt when its event signature changes
// (event count + highest seq). This preserves the DOM the user is looking at
// — expanded <details>, scroll position — across the 2.5s poll, instead of
// wholesale-replacing root.innerHTML like the old version did.
function renderTranscript(root, events, runId) {
  if (!root) return
  if (!events || events.length === 0) {
    root.innerHTML = '<div class="empty">No trace events for this run.</div>'
    return
  }

  // Ensure the live banner exists exactly once and reflects current state.
  let banner = root.querySelector("#ts-live-banner")
  if (!banner) {
    // First render of this transcript root — start clean.
    root.innerHTML =
      '<div class="ts-live-banner" id="ts-live-banner"><span class="ts-live-dot"></span> <span id="ts-live-text">running…</span></div>'
    banner = root.querySelector("#ts-live-banner")
    // Forget any cached cards from a previous run mounted in this root.
    delete root._stepCards
  }
  banner.style.display = transcriptRunActive ? "flex" : "none"

  // Split into: top-level (parentId null/empty) vs nested sub-agent events.
  const topLevel = []
  const nestedByParent = {} // parentId -> [events]
  for (const e of events) {
    if (e.parentId) {
      ;(nestedByParent[e.parentId] = nestedByParent[e.parentId] || []).push(e)
    } else {
      topLevel.push(e)
    }
  }

  // Group top-level events by stepNumber. Events without a stepNumber
  // (run_start, run_end, system-prompt) bucket under step null.
  const steps = {} // stepNumber -> [events]
  const order = [] // preserve first-seen step order
  for (const e of topLevel) {
    const k = e.stepNumber == null ? "_pre" : e.stepNumber
    if (!steps[k]) {
      steps[k] = []
      order.push(k)
    }
    steps[k].push(e)
  }

  // Cache of rendered step cards on this root: stepKey -> { el, signature }.
  const cache = root._stepCards || (root._stepCards = new Map())
  const seen = new Set()

  for (const stepKey of order) {
    const evs = steps[stepKey]
    // Signature: number of events + the max seq we've seen for this step.
    // Changing either means the step grew (or got a step_end summary) and
    // its card needs to be rebuilt.
    let maxSeq = 0
    for (const e of evs) if ((e.seq || 0) > maxSeq) maxSeq = e.seq || 0
    const sig = evs.length + ":" + maxSeq
    seen.add(stepKey)
    const cached = cache.get(stepKey)
    if (cached && cached.signature === sig) continue // unchanged — keep DOM
    // (Re)build this step's card.
    const isPre = stepKey === "_pre"
    const stepNum = isPre ? null : stepKey
    const html = renderStepCard(stepNum, evs, nestedByParent)
    const tmp = document.createElement("div")
    tmp.innerHTML = html
    const card = tmp.firstElementChild
    // Tag the card with its step key so loadTranscript can tell a populated
    // root from a first-load empty one without depending on the banner.
    if (card) card.setAttribute("data-step-key", stepKey)
    if (cached) {
      // Replace the existing card in place (preserves step ordering).
      cached.el.replaceWith(card)
    } else {
      // New step — append after the last existing step card (or the banner).
      const insertAfter =
        (cache.size && Array.from(cache.values()).pop().el) || banner
      insertAfter.after(card)
    }
    cache.set(stepKey, { el: card, signature: sig })
  }
  // Steps can only grow during a run, so we don't prune; but if a future
  // caller passes a smaller event set, drop any cards no longer present.
  for (const [k, v] of cache) {
    if (!seen.has(k)) {
      v.el.remove()
      cache.delete(k)
    }
  }
}

function renderStepCard(stepNum, evs, nestedByParent) {
  // Bucket the step's events by type so we can render them in a fixed order.
  const byType = {}
  for (const e of evs) {
    ;(byType[e.eventType] = byType[e.eventType] || []).push(e)
  }
  // Pick the agent + model + tokens from the step_end event (the authoritative
  // per-turn summary). Fallbacks for steps without one.
  const stepEnd = (byType.step_end || [])[0]
  const agent = stepEnd?.agent || (evs[0] && evs[0].agent) || "harness"
  const model = stepEnd?.model || null
  const ts = evs[0]?.createdAt || stepEnd?.createdAt || null
  const tokensIn = stepEnd?.tokensIn
  const tokensOut = stepEnd?.tokensOut
  const tokensReasoning = stepEnd?.tokensReasoning
  const cacheRead = stepEnd?.cacheRead
  const dur = stepEnd?.durationMs

  const agentClass = "ts-agent-" + (agent || "harness")

  let metaParts = []
  if (ts) metaParts.push(fmtTime(ts))
  metaParts.push('<span class="ts-agent-tag ' + agentClass + '">' + md.escapeHtml(agent) + "</span>")
  if (model) metaParts.push(md.escapeHtml(model))
  let tokParts = []
  if (tokensIn != null) tokParts.push('in <b style="color:var(--steel)">' + tokensIn.toLocaleString() + "</b>")
  if (tokensOut != null) tokParts.push('out <b style="color:var(--ok)">' + tokensOut.toLocaleString() + "</b>")
  if (tokensReasoning != null && tokensReasoning > 0)
    tokParts.push('reasoning <b style="color:var(--warn)">' + tokensReasoning.toLocaleString() + "</b>")
  if (cacheRead != null && cacheRead > 0) tokParts.push("cache " + cacheRead.toLocaleString())
  if (dur != null) tokParts.push((dur / 1000).toFixed(1) + "s")
  if (tokParts.length) metaParts.push(tokParts.join(" · "))

  const blocks = []
  // SYSTEM PROMPT
  for (const e of byType.system || []) {
    if (e.label === "plan") continue // plan rendered separately if desired
    blocks.push(renderCollapsibleBlock("SYSTEM PROMPT", e, "system"))
  }
  // MESSAGES SENT (prompt)
  for (const e of byType.prompt || []) {
    blocks.push(renderCollapsibleBlock("MESSAGES SENT", e, "prompt"))
  }
  // REASONING
  for (const e of byType.reasoning || []) {
    blocks.push(renderMarkdownBlock("REASONING", e, "reasoning"))
  }
  // TOOL CALLS (paired with results + nested sub-agent events)
  const toolCalls = byType.tool_call || []
  const toolResults = byType.tool_result || []
  for (const tc of toolCalls) {
    const result = toolResults.find(
      tr => tr.toolCallId && tr.toolCallId === tc.toolCallId,
    )
    const nested = (tc.toolCallId && nestedByParent[tc.toolCallId]) || []
    blocks.push(renderToolBlock(tc, result, nested, nestedByParent))
  }
  // Standalone tool_results without a matching call (rare; e.g. sub-agent
  // events that surfaced at top level). Skip — they're nested or redundant.
  // TEXT
  for (const e of byType.text || []) {
    blocks.push(renderMarkdownBlock("TEXT", e, "text"))
  }
  // RESPONSE (step_end detail)
  if (stepEnd) {
    blocks.push(renderCollapsibleBlock("RESPONSE", stepEnd, "step_end"))
  }

  return (
    '<div class="ts-step ' + agentClass + '">' +
    '<div class="ts-step-head">' +
    (stepNum != null
      ? '<span class="ts-step-num">STEP ' + stepNum + "</span>"
      : '<span class="ts-step-num ts-step-pre">RUN</span>') +
    '<span class="ts-step-meta">' + metaParts.join(" · ") + "</span>" +
    "</div>" +
    '<div class="ts-step-body">' +
    blocks.join("") +
    "</div>" +
    "</div>"
  )
}

function renderCollapsibleBlock(title, e, typeClass) {
  const trunc = e.truncated ? '<span class="ts-trunc">truncated</span>' : ""
  const payload = e.payload || ""
  // system/prompt payloads are JSON strings or raw text; pretty-print if JSON.
  const body = looksLikeJson(payload)
    ? renderJson(payload, { maxChars: 20000 })
    : "<pre>" + md.escapeHtml(payload) + "</pre>"
  return (
    '<div class="ts-block ts-block-' + typeClass + '">' +
    '<details><summary class="ts-block-title">' +
    md.escapeHtml(title) +
    trunc +
    "</summary>" +
    '<div class="ts-block-body">' +
    body +
    "</div></details>" +
    "</div>"
  )
}

function renderMarkdownBlock(title, e, typeClass) {
  const trunc = e.truncated ? '<span class="ts-trunc">truncated</span>' : ""
  const body = e.payload
    ? '<div class="md-body md-body-tight">' + md.render(e.payload) + "</div>"
    : '<span class="empty">—</span>'
  return (
    '<div class="ts-block ts-block-' + typeClass + '">' +
    '<div class="ts-block-title-row">' +
    '<span class="ts-block-title-inline">' + md.escapeHtml(title) + "</span>" +
    trunc +
    "</div>" +
    '<div class="ts-block-body">' + body + "</div>" +
    "</div>"
  )
}

function renderToolBlock(callEv, resultEv, nested, nestedByParent) {
  const toolName = callEv.label || "tool"
  const caller = callEv.agent || "harness"
  const args = callEv.payload || ""
  const result = resultEv?.payload || null
  const dur = resultEv?.durationMs
  const callTrunc = callEv.truncated
    ? '<span class="ts-trunc">args truncated</span>'
    : ""
  const resTrunc = resultEv?.truncated
    ? '<span class="ts-trunc">result truncated</span>'
    : ""

  // Render the nested sub-agent events (grouped into their own step cards).
  let nestedHtml = ""
  if (nested && nested.length > 0) {
    // Group nested events by their stepNumber for sub-step cards.
    const subSteps = {}
    const subOrder = []
    for (const e of nested) {
      const k = e.stepNumber == null ? "_s" : e.stepNumber
      if (!subSteps[k]) {
        subSteps[k] = []
        subOrder.push(k)
      }
      subSteps[k].push(e)
    }
    const subCards = subOrder.map(k => {
      const subAgent = (nested[0] && nested[0].agent) || "sub-agent"
      return renderSubStepCard(k === "_s" ? null : k, subSteps[k], subAgent)
    })
    nestedHtml =
      '<div class="ts-nest">' +
      '<div class="ts-nest-label">└ nested: ' +
      md.escapeHtml(nested[0].agent || "sub-agent") +
      " · " +
      nested.length +
      " events</div>" +
      subCards.join("") +
      "</div>"
  }

  return (
    '<div class="ts-block ts-block-tool">' +
    '<div class="ts-tool-head">' +
    '<span class="ts-tool-icon">🔧</span>' +
    '<span class="ts-tool-name">' + md.escapeHtml(toolName) + "</span>" +
    '<span class="ts-tool-caller">called by <b>' +
    md.escapeHtml(caller) + "</b></span>" +
    (callEv.toolCallId
      ? '<span class="ts-tool-id">id ' + md.escapeHtml(callEv.toolCallId.slice(0, 12)) + "</span>"
      : "") +
    (dur != null ? '<span class="ts-tool-dur">' + (dur / 1000).toFixed(1) + "s</span>" : "") +
    "</div>" +
    '<div class="ts-tool-args">' +
    '<div class="ts-mini-label">args ' + callTrunc + "</div>" +
    (args
      ? looksLikeJson(args)
        ? renderJson(args, { maxChars: 20000 })
        : "<pre>" + md.escapeHtml(args) + "</pre>"
      : '<span class="empty">—</span>') +
    "</div>" +
    nestedHtml +
    (result != null
      ? '<div class="ts-tool-result">' +
        '<div class="ts-mini-label">→ result ' + resTrunc + "</div>" +
        (looksLikeJson(result)
          ? renderJson(result, { maxChars: 20000 })
          : "<pre>" + md.escapeHtml(result) + "</pre>") +
        "</div>"
      : "") +
    "</div>"
  )
}

// A sub-agent step card (lighter styling than a top-level step).
function renderSubStepCard(stepNum, evs, agent) {
  const byType = {}
  for (const e of evs) {
    ;(byType[e.eventType] = byType[e.eventType] || []).push(e)
  }
  const stepEnd = (byType.step_end || [])[0]
  const tokOut = stepEnd?.tokensOut
  const dur = stepEnd?.durationMs
  const blocks = []
  for (const e of byType.reasoning || [])
    blocks.push(renderMarkdownBlock("reasoning", e, "reasoning"))
  for (const tc of byType.tool_call || []) {
    const tr = (byType.tool_result || []).find(
      x => x.toolCallId && x.toolCallId === tc.toolCallId,
    )
    if (tr) {
      // Inline a compact tool row for sub-agent calls.
      blocks.push(
        '<div class="ts-subtool">' +
        '<span class="ts-tool-icon">🔧</span>' +
        '<span class="ts-tool-name">' + md.escapeHtml(tc.label || "tool") + "</span>" +
        (tr.durationMs != null
          ? '<span class="ts-tool-dur">' + (tr.durationMs / 1000).toFixed(1) + "s</span>"
          : "") +
        '<details class="ts-subtool-det"><summary>args/result</summary>' +
        '<div class="ts-block-body">' +
        (tc.payload ? renderJson(tc.payload, { maxChars: 6000 }) : "") +
        (tr.payload ? renderJson(tr.payload, { maxChars: 6000 }) : "") +
        "</div></details>" +
        "</div>",
      )
    }
  }
  for (const e of byType.text || [])
    blocks.push(renderMarkdownBlock("text", e, "text"))

  let meta = []
  if (stepNum != null) meta.push("step " + stepNum)
  if (tokOut != null) meta.push(tokOut.toLocaleString() + " tok")
  if (dur != null) meta.push((dur / 1000).toFixed(1) + "s")
  return (
    '<div class="ts-substep">' +
    (meta.length ? '<div class="ts-substep-meta">' + meta.join(" · ") + "</div>" : "") +
    blocks.join("") +
    "</div>"
  )
}

function fmtTime(iso) {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    return (
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      " · " +
      d.toLocaleDateString([], { month: "short", day: "numeric" })
    )
  } catch (_) {
    return ""
  }
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

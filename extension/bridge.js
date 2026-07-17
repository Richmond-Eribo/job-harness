// =============================================================================
// Bridge — the WebSocket relay + chrome.debugger CDP adapter.
// =============================================================================
// Holds the single outbound WS to the worker and bridges CDP frames between
// it and the active tab's debugger session. Frame protocol (matches the relay
// DO in src/agents/browser-relay.ts):
//   OUT  { t:"hello", version, ua }
//   OUT  { t:"cdp", id, method, params? }      ← relay → here
//   IN   { t:"cdp-res", id, result?, error? }  ← here → relay
//   IN   { t:"cdp-event", method, params }     ← unsolicited CDP events
//   BOTH { t:"ping" } / { t:"pong" }           ← heartbeat
// =============================================================================

let ws = null
let connectedAt = null
let reconnectTimer = null
const TARGET_VERSION = "1.0.0"

export async function getState() {
  return {
    connected: !!ws && ws.readyState === 1,
    workerUrl: (await chrome.storage.local.get("workerUrl")).workerUrl ?? null,
    activeTabId: agentTabId,
    connectedAt,
  }
}

export async function setState(patch) {
  const cur = await chrome.storage.local.get(Object.keys(patch))
  await chrome.storage.local.set({ ...cur, ...patch })
}

// ── Publish connection state to storage so the popup can read it WITHOUT a
// sendMessage round-trip (which hangs in MV3). The popup watches storage.
// `reason` is shown when disconnected so the operator sees WHY (e.g. error).
let lastWorkerUrl = null
function publishState(reason) {
  const connected = !!ws && ws.readyState === 1
  try {
    chrome.storage.local.set({
      relayState: {
        connected,
        activeTabId: agentTabId,
        connectedAt: connected ? connectedAt : null,
        workerUrl: lastWorkerUrl,
        reason: connected ? null : reason || "disconnected",
        at: Date.now(),
      },
    })
  } catch {
    // storage may be unavailable transiently — non-fatal
  }
}

// ── Connect: open the WS, attach the debugger to the active tab. ──────────
export function connectRelay(workerUrl) {
  if (!workerUrl) return
  lastWorkerUrl = workerUrl
  // Cancel any pending reconnect from a previous session.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const base = workerUrl.replace(/\/+$/, "")
  const wsUrl = base.replace(/^http/, "ws") + "/browser/relay"
  publishState("connecting")
  if (ws && ws.readyState <= 1) {
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
  try {
    ws = new WebSocket(wsUrl)
  } catch (e) {
    publishState("invalid URL")
    scheduleReconnect(workerUrl)
    return
  }

  ws.onopen = async () => {
    connectedAt = new Date().toISOString()
    const ua = navigator.userAgent
    safeSend({ t: "hello", version: TARGET_VERSION, ua })
    startHeartbeat()
    await attachActiveTab()
    publishState()
  }

  ws.onmessage = ev => onMessage(ev.data)

  ws.onclose = () => {
    connectedAt = null
    stopHeartbeat()
    detachTab()
    publishState("connection closed — reconnecting")
    scheduleReconnect(workerUrl)
  }
  ws.onerror = () => {
    publishState("connection error")
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
}

// ── Disconnect: drop the WS + detach the debugger. Called by the popup's
// Disconnect button and when the stored workerUrl is cleared. Cancels any
// pending reconnect so a disconnect actually stays disconnected.
export function disconnectRelay() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHeartbeat()
  if (ws) {
    try {
      ws.onclose = null // suppress auto-reconnect on intentional close
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }
  connectedAt = null
  detachTab()
  publishState("disconnected")
}

function scheduleReconnect(workerUrl) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectRelay(workerUrl)
  }, 5000) // backoff — MV3 SW may be killed regardless; onStartup resumes.
}

// ── Dedicated agent tab. The extension owns ONE tab for the agent and drives
// only that — it never touches the user's focused tab. This avoids the "agent
// hijacks the tab I'm reading" problem. The tab is created on first use and
// reused across calls; if the user closes it, the next command reopens it.
// Kept non-active (background) so it doesn't steal focus while the user browses.

let agentTabId = null // the dedicated tab the debugger is attached to
let agentTabAttached = false // explicit attach-state flag (survives the race)

async function attachActiveTab() {
  await ensureAgentTab()
}

// ── Ensure a dedicated agent tab exists + the debugger is ATTACHED. Called
// before every CDP command. Tracks attach state explicitly so we never hand
// the relay a tab id whose debugger isn't ready yet (the original race: the
// tab existed but sendCommand hit "Debugger is not attached").
async function ensureAgentTab() {
  // Fast path: tab exists AND is confirmed attached.
  if (agentTabId != null && agentTabAttached) {
    try {
      await chrome.tabs.get(agentTabId)
      return // alive + attached — good to go
    } catch {
      // tab was closed by the user — reset + reopen below
      agentTabAttached = false
      agentTabId = null
    }
  }

  // Tab missing or not attached. If a tab exists but isn't attached, try to
  // attach it first (recover without reopening).
  if (agentTabId != null && !agentTabAttached) {
    if (await tryAttach(agentTabId)) return
    // attach failed (tab may be dead) → close + reopen
    try {
      await chrome.tabs.remove(agentTabId)
    } catch {
      // ignore
    }
    agentTabId = null
  }

  // Open a fresh dedicated tab in the background (active:false = no focus steal).
  try {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false })
    agentTabId = tab.id
    publishState("opened agent tab")
  } catch (e) {
    publishState("failed to open agent tab: " + (e?.message || "?"))
    agentTabId = null
    return
  }

  // Attach with retries — about:blank needs a moment before the debugger can
  // latch on. tryAttach sets agentTabAttached on success.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await tryAttach(agentTabId)) return
    await new Promise(r => setTimeout(r, 400))
  }
  publishState("debugger attach failed on agent tab")
}

// Try to attach the debugger to a tab. Returns true on success (including the
// "already attached" case). Sets agentTabAttached + wires event forwarding.
async function tryAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3")
    agentTabAttached = true
    chrome.debugger.onEvent.removeListener(onDebugEvent)
    chrome.debugger.onEvent.addListener(onDebugEvent)
    publishState()
    return true
  } catch (e) {
    const msg = String(e?.message || "")
    if (msg.includes("Another debugger is already attached")) {
      agentTabAttached = true
      chrome.debugger.onEvent.removeListener(onDebugEvent)
      chrome.debugger.onEvent.addListener(onDebugEvent)
      publishState()
      return true
    }
    return false
  }
}

// Listen for the user closing our tab so we reopen on next use.
chrome.tabs.onRemoved.addListener((removedId) => {
  if (removedId === agentTabId) {
    agentTabId = null
    agentTabAttached = false
  }
})

// If the debugger detaches for any reason (user closed the infobar, etc.),
// clear the flag so the next command re-attaches.
chrome.debugger.onDetach.addListener((_source, reason) => {
  agentTabAttached = false
  publishState("debugger detached (" + (reason || "?") + ") — will re-attach")
})

async function detachTab() {
  if (agentTabId == null) return
  if (agentTabAttached) {
    try {
      await chrome.debugger.detach({ tabId: agentTabId })
    } catch {
      // ignore
    }
  }
  // Close the dedicated tab on disconnect so it doesn't linger.
  try {
    await chrome.tabs.remove(agentTabId)
  } catch {
    // ignore
  }
  agentTabId = null
  agentTabAttached = false
}

function onDebugEvent(_source, method, params) {
  // Forward unsolicited browser events (Page.frameNavigated, etc.) to the relay.
  safeSend({ t: "cdp-event", method, params })
}

// ── Handle a frame from the relay: run the CDP command, reply. ────────────
async function onMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (msg.t === "ping") return safeSend({ t: "pong" })
  if (msg.t !== "cdp" || typeof msg.id !== "number") return

  // Ensure the dedicated agent tab exists + is attached before every command.
  // The agent drives ONLY this tab — never the user's focused tab — so the
  // user can browse freely while a run is in progress. If the tab was closed,
  // it's reopened here.
  await ensureAgentTab()
  if (agentTabId == null) {
    return safeSend({
      t: "cdp-res",
      id: msg.id,
      error: {
        message: "No drivable agent tab. Reload the extension and retry.",
      },
    })
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: agentTabId },
      msg.method,
      msg.params || {},
    )
    safeSend({ t: "cdp-res", id: msg.id, result: result ?? {} })
  } catch (e) {
    safeSend({
      t: "cdp-res",
      id: msg.id,
      error: { message: e?.message || "cdp command failed" },
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function safeSend(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj))
    } catch {
      // ignore
    }
  }
}

let heartbeatTimer = null
function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => safeSend({ t: "ping" }), 25000)
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

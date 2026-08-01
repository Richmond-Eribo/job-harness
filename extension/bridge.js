// =============================================================================
// Bridge — the WebSocket relay + chrome.debugger CDP adapter.
// =============================================================================
// Holds the single outbound WS to the worker and bridges CDP frames between
// it and the dedicated agent tab. Frame protocol (matches the relay DO in
// src/agents/browser-relay.ts):
//   OUT  { t:"hello", version, ua }
//   OUT  { t:"cdp", id, method, params? }      ← relay → here
//   IN   { t:"cdp-res", id, result?, error? }  ← here → relay
//   IN   { t:"cdp-event", method, params }     ← unsolicited CDP events
//   BOTH { t:"ping" } / { t:"pong" }           ← heartbeat
//
// AUTH (rewritten for the pairing flow — see src/auth/extension-pairing.ts)
// The worker's /browser/relay upgrade REQUIRES a signed extension token,
// presented via the WS subprotocol: new WebSocket(url, ["ja-ext-token.<jwt>"]).
// Previously this file opened the socket with NO token at all — every
// connection attempt 401'd before the WS ever reached OPEN. Now:
//   • Storage holds {workerUrl, refreshToken, accessToken, accessTokenExpiresAt}.
//   • Before connecting, refresh the access token if it's missing or expiring
//     within 5 minutes (POST /api/browser/refresh — no session needed, the
//     refresh token itself is the credential).
//   • The access token is passed as the WS subprotocol on every connection.
//   • If a connection attempt closes WITHOUT ever reaching OPEN (the closest
//     signal a browser WebSocket gives you to "the server rejected the
//     handshake", since 401 responses don't expose a JS-readable status),
//     try exactly ONE forced refresh + immediate retry before falling back to
//     the normal exponential-backoff reconnect loop. This recovers from an
//     expired-but-refreshable access token without user interaction, while
//     not looping forever if the refresh token itself is invalid/revoked.
// =============================================================================

let ws = null
let connectedAt = null
let reconnectTimer = null
let reconnectAttempt = 0 // resets to 0 on a successful OPEN; drives backoff
let didOpenThisCycle = false // did the CURRENT ws instance ever reach OPEN?
let triedAutoRefreshThisCycle = false // guards the one-shot refresh-then-retry
const TARGET_VERSION = "1.1.0"
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const REFRESH_SKEW_MS = 5 * 60 * 1000 // refresh if expiring within 5 minutes

export async function getState() {
  const stored = await chrome.storage.local.get([
    "workerUrl",
    "refreshToken",
    "accessTokenExpiresAt",
  ])
  return {
    connected: !!ws && ws.readyState === 1,
    workerUrl: stored.workerUrl ?? null,
    paired: !!stored.refreshToken,
    accessTokenExpiresAt: stored.accessTokenExpiresAt ?? null,
    activeTabId: agentTabId,
    connectedAt,
  }
}

// ── Publish connection state to storage so the popup can read it WITHOUT a
// sendMessage round-trip (which hangs in MV3). The popup watches storage.
// `reason` is shown when disconnected so the operator sees WHY (e.g. error).
function publishState(reason) {
  const connected = !!ws && ws.readyState === 1
  try {
    chrome.storage.local.get(["workerUrl"]).then(({ workerUrl }) => {
      chrome.storage.local.set({
        relayState: {
          connected,
          activeTabId: agentTabId,
          connectedAt: connected ? connectedAt : null,
          workerUrl: workerUrl ?? null,
          reason: connected ? null : reason || "disconnected",
          at: Date.now(),
        },
      })
    })
  } catch {
    // storage may be unavailable transiently — non-fatal
  }
}

// ── Token refresh ──────────────────────────────────────────────────────────
// Exchanges the stored refresh token for a fresh 1h access token. Returns the
// new access token on success, or null on failure (invalid/revoked refresh
// token, network error) — callers fall back to their normal error handling.
async function refreshAccessToken(workerUrl, refreshToken) {
  try {
    const res = await fetch(
      workerUrl.replace(/\/+$/, "") + "/api/browser/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    )
    if (!res.ok) return null
    const data = await res.json()
    const accessTokenExpiresAt = Date.now() + (data.accessTokenExpiresIn ?? 3600) * 1000
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      accessTokenExpiresAt,
    })
    return data.accessToken
  } catch {
    return null
  }
}

/**
 * Redeem a pairing code (typed into the popup) for a refresh token + an
 * immediate access token. Called by popup.js — NOT part of the connect flow
 * itself, but stores its result in the same shape connectRelay() expects.
 */
export async function redeemPairingCode(workerUrl, code) {
  const base = workerUrl.replace(/\/+$/, "")
  const res = await fetch(base + "/api/browser/pair/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error || `Pairing failed (${res.status})`)
  }
  const accessTokenExpiresAt = Date.now() + (data.accessTokenExpiresIn ?? 3600) * 1000
  await chrome.storage.local.set({
    workerUrl: base,
    refreshToken: data.refreshToken,
    accessToken: data.accessToken,
    accessTokenExpiresAt,
  })
  return data
}

/** Forget pairing entirely — clears all stored credentials + disconnects. */
export async function forgetPairing() {
  disconnectRelay()
  // Clear intent so background.js's chrome.alarms watchdog stops trying to
  // reconnect after the user explicitly forgot this browser.
  await chrome.storage.local.set({ wantsConnect: false })
  await chrome.storage.local.remove([
    "workerUrl",
    "refreshToken",
    "accessToken",
    "accessTokenExpiresAt",
  ])
}

/**
 * Watchdog entry point — called by background.js's chrome.alarms tick.
 *
 * WHY: MV3 evicts the service worker after ~30s of inactivity, which destroys
 * every setTimeout/setInterval in this module (including reconnectTimer and
 * heartbeatTimer). The only way to resume after eviction is an externally-
 * driven wake — and chrome.alarms is the ONLY MV3 timer that survives eviction
 * and wakes the SW. After a worker restart the reconnection chain laid down by
 * connectRelay can die silently with the SW; this function is the backstop.
 *
 * Idempotent: if we're already OPEN, no-op; if we're paired but disconnected,
 * kick the connect loop. Skips entirely when not paired, when the user has
 * forgotten (wantsConnect === false), or when workerUrl is missing.
 */
export async function ensureConnectedFromStorage() {
  const { wantsConnect, workerUrl } = await chrome.storage.local.get([
    "wantsConnect",
    "workerUrl",
  ])
  if (!wantsConnect || !workerUrl) return
  if (ws && ws.readyState === 1) return // already open — nothing to do
  await connectRelay(workerUrl)
}

// ── Connect: refresh the access token if needed, then open the WS. ────────
export async function connectRelay(workerUrl) {
  if (!workerUrl) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  // Persist intent so background.js's chrome.alarms watchdog can resume after
  // a service-worker eviction. setTimeout/setInterval die with the SW; the
  // alarm is the only MV3 timer that wakes an evicted SW. Cleared only by
  // forgetPairing(). Set this BEFORE the not-paired early-return so a paired
  // extension that has lost pairing will not be reconnected by the watchdog.
  await chrome.storage.local.set({ wantsConnect: true })

  const stored = await chrome.storage.local.get([
    "refreshToken",
    "accessToken",
    "accessTokenExpiresAt",
  ])
  if (!stored.refreshToken) {
    // Not paired yet — nothing to connect with. The popup's pairing flow
    // (redeemPairingCode) is what populates refreshToken.
    publishState("not paired — pair the extension from the dashboard")
    return
  }

  let accessToken = stored.accessToken
  const expiresAt = stored.accessTokenExpiresAt ?? 0
  if (!accessToken || expiresAt - Date.now() < REFRESH_SKEW_MS) {
    publishState("refreshing access token")
    accessToken = await refreshAccessToken(workerUrl, stored.refreshToken)
    if (!accessToken) {
      publishState("pairing expired or revoked — re-pair the extension")
      return
    }
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

  didOpenThisCycle = false
  try {
    ws = new WebSocket(wsUrl, ["ja-ext-token." + accessToken])
  } catch (e) {
    publishState("invalid URL")
    scheduleReconnect(workerUrl)
    return
  }

  ws.onopen = async () => {
    didOpenThisCycle = true
    triedAutoRefreshThisCycle = false
    reconnectAttempt = 0
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

    // The handshake never completed → almost certainly a rejected/expired
    // token (or a network failure). Try ONE forced refresh + immediate
    // reconnect before falling into the normal backoff loop, so an expired
    // access token self-heals without user interaction.
    if (!didOpenThisCycle && !triedAutoRefreshThisCycle) {
      triedAutoRefreshThisCycle = true
      publishState("auth may have expired — retrying with a fresh token")
      chrome.storage.local.get(["refreshToken"]).then(({ refreshToken }) => {
        if (!refreshToken) {
          publishState("not paired — pair the extension from the dashboard")
          return
        }
        refreshAccessToken(workerUrl, refreshToken).then(token => {
          if (token) {
            connectRelay(workerUrl)
          } else {
            publishState("pairing expired or revoked — re-pair the extension")
          }
        })
      })
      return
    }

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
// Disconnect button and when pairing is forgotten. Cancels any pending
// reconnect so a disconnect actually stays disconnected.
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

// Exponential backoff + jitter, capped at RECONNECT_MAX_MS. Replaces the
// previous fixed 5s delay — a fixed interval means every disconnected
// extension retries in lockstep, which is unfriendly to a struggling worker
// and wastes battery/network on a genuinely offline connection. Backoff
// resets to the base delay on the next successful OPEN (see ws.onopen).
function scheduleReconnect(workerUrl) {
  if (reconnectTimer) return
  const attempt = reconnectAttempt++
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  const jitter = Math.random() * exp * 0.3
  const delay = Math.min(RECONNECT_MAX_MS, exp + jitter)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectRelay(workerUrl)
  }, delay)
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
  if (msg.t === "pong") { lastPongAt = Date.now(); return }
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
let lastPongAt = 0

function startHeartbeat() {
  stopHeartbeat()
  lastPongAt = Date.now()
  // 15s ping cadence + 30s pong sanity window. A *clean* server restart
  // (e.g. `wrangler dev` reload, or Ctrl+C of the API worker) sends NO TCP RST
  // to the client, so the WebSocket lingers in readyState=OPEN pointing at
  // nothing. The old fire-and-forget 25s ping never closed the socket on a
  // missing pong, so the dead WS survived indefinitely and the worker's
  // targetKind() reported "none" forever while the extension believed it was
  // connected. Now: if we haven't seen a pong in 30s, force-close the WS —
  // onclose runs the normal reconnect path, which is also backed by the
  // chrome.alarms watchdog in background.js.
  heartbeatTimer = setInterval(() => {
    safeSend({ t: "ping" })
    if (Date.now() - lastPongAt > 30_000) {
      try { ws && ws.close() } catch { /* ignore */ }
    }
  }, 15_000)
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

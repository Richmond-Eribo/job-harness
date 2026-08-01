// =============================================================================
// Agent Harness — Browser Relay extension (service worker / background).
// =============================================================================
// This extension connects your REAL, logged-in Chrome to the Agent Harness
// worker so the agent can browse login-walled job sites (Indeed, LinkedIn,
// Glassdoor) using your existing sessions. The worker can't reach a browser
// behind NAT, so the browser reaches OUT to the worker over a WebSocket.
//
// MECHANICS
//   1. The service worker reads {workerUrl, refreshToken} from
//      chrome.storage.local — set by the popup's pairing flow (a 6-char code
//      from the dashboard, exchanged via /api/browser/pair/redeem).
//   2. It refreshes a short-lived access token from the refresh token, then
//      opens a WebSocket to wss://<worker>/browser/relay presenting that
//      access token via the WS subprotocol.
//   3. It attaches chrome.debugger to a dedicated background agent tab (CDP
//      over the debugger API) — never the user's active tab.
//   4. It relays CDP commands from the worker → chrome.debugger.sendCommand,
//      and responses/events back over the WebSocket.
//
// IPC MODEL (MV3-safe)
//   The popup writes {workerUrl, refreshToken, accessToken, ...} to storage;
//   this file's storage.onChanged listener connects/disconnects. The bridge
//   publishes relayState to storage so the popup can read connection state
//   WITHOUT a sendMessage round-trip (which hangs in MV3 if the listener
//   doesn't perfectly manage sendResponse). Storage is the single durable IPC
//   channel here.
//
// CREDENTIALS SAFETY
//   Credentials NEVER leave the browser. The agent only ever reads pages you
//   have already logged into; it never types passwords itself.
//
// SETUP
//   1. chrome://extensions → Developer mode → Load unpacked → extension/ folder.
//   2. On the dashboard, open Settings → Browser & Extension → "Pair new
//      browser" to get a 6-character code.
//   3. Click the toolbar icon, enter the code, Pair.
// =============================================================================

import { connectRelay, disconnectRelay, ensureConnectedFromStorage } from "./bridge.js"

// On install + SW wake: auto-connect if pairing already exists. connectRelay
// itself no-ops (with a clear relayState reason) if refreshToken is missing,
// so this is safe to call unconditionally.
chrome.runtime.onInstalled.addListener(async () => {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) connectRelay(workerUrl)
})

chrome.runtime.onStartup.addListener(async () => {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) connectRelay(workerUrl)
})

// THE connect/disconnect trigger. The popup's pairing flow writes
// {workerUrl, refreshToken, accessToken} to storage on success, or removes
// them on "Forget this browser" — this fires either way. This is the whole
// control path — no messaging involved, so it can't hang.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (changes.refreshToken) {
    const hasToken = !!changes.refreshToken.newValue
    if (hasToken) {
      chrome.storage.local.get("workerUrl").then(({ workerUrl }) => {
        if (workerUrl) connectRelay(workerUrl)
      })
    } else {
      disconnectRelay()
    }
  }
})

// Best-effort message listener for any caller still using sendMessage.
// Returns true only for the async state query; replies synchronously
// otherwise so the channel never hangs.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.t === "relay-state") {
    chrome.storage.local.get("relayState").then(({ relayState }) =>
      sendResponse(relayState || { connected: false }),
    )
    return true // keep the channel open for the async reply
  }
  // Don't act on connect/disconnect messages here — the popup now drives via
  // storage, and storage.onChanged above is the canonical trigger. Ack only.
  sendResponse({ ok: true, note: "driven via storage.onChanged" })
})

// ── MV3 service-worker eviction backstop ────────────────────────────────
// The service worker is evicted by Chrome after ~30s of inactivity, which
// destroys every setTimeout/setInterval in bridge.js — including the WS
// reconnect timer and the heartbeat. After eviction the SW is NOT auto-revived
// by anything server-side (onInstalled/onStartup only fire on extension or
// browser restart), so a worker restart leaves the extension dead indefinitely
// — pairing data survives in chrome.storage.local but nothing reads it.
//
// chrome.alarms is the ONLY MV3 timer that survives eviction AND wakes the SW.
// A 30s tick gives us a reliable reconnect: every 30s the SW wakes, calls
// ensureConnectedFromStorage(), and either no-ops (already OPEN), reconnects
// (worker is back / WS died silently / SW was evicted mid-connect), or skips
// (not paired, or `wantsConnect` was cleared by Forget). Idempotent inside the
// bridge — safe to fire even mid-connect.
chrome.alarms.create("relay-watchdog", { periodInMinutes: 0.5 }) // 30s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "relay-watchdog") {
    ensureConnectedFromStorage().catch(() => {
      // non-fatal — next tick retries. This typically fires when the SW has
      // been evicted and the connect attempt itself fails; the alarm reschedules.
    })
  }
})

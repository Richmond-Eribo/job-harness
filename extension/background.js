// =============================================================================
// Agent Harness — Browser Relay extension (service worker / background).
// =============================================================================
// This extension connects your REAL, logged-in Chrome to the Agent Harness
// worker so the agent can browse login-walled job sites (Indeed, LinkedIn,
// Glassdoor) using your existing sessions. The worker can't reach a browser
// behind NAT, so the browser reaches OUT to the worker over a WebSocket.
//
// MECHANICS
//   1. The service worker reads workerUrl from chrome.storage.local.
//   2. It opens a WebSocket to wss://<worker>/browser/relay.
//   3. It attaches chrome.debugger to the active tab (CDP over the debugger API).
//   4. It relays CDP commands from the worker → chrome.debugger.sendCommand,
//      and responses/events back over the WebSocket.
//
// IPC MODEL (MV3-safe)
//   The popup writes workerUrl to storage; this file's storage.onChanged
//   listener connects/disconnects. The bridge publishes relayState to storage
//   so the popup can read connection state WITHOUT a sendMessage round-trip
//   (which hangs in MV3 if the listener doesn't perfectly manage sendResponse).
//   Storage is the single durable IPC channel here.
//
// CREDENTIALS SAFETY
//   Credentials NEVER leave the browser. The agent only ever reads pages you
//   have already logged into; it never types passwords itself.
//
// SETUP
//   1. chrome://extensions → Developer mode → Load unpacked → extension/ folder.
//   2. Click the toolbar icon, enter your worker URL, Save & Connect.
//   3. Keep a tab open + focused.
// =============================================================================

import { connectRelay, disconnectRelay } from "./bridge.js"

// On install + SW wake: auto-connect if a URL is already saved.
chrome.runtime.onInstalled.addListener(async () => {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) connectRelay(workerUrl)
})

chrome.runtime.onStartup.addListener(async () => {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) connectRelay(workerUrl)
})

// THE connect/disconnect trigger. The popup writes workerUrl to storage; this
// fires. Null/cleared → disconnect; set → connect. This is the whole control
// path — no messaging involved, so it can't hang.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (changes.workerUrl) {
    const url = changes.workerUrl.newValue
    if (url) connectRelay(url)
    else disconnectRelay()
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

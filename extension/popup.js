// =============================================================================
// Popup — pairing UX. NO manual token entry, NO sendMessage.
// =============================================================================
// TWO STATES:
//   • Unpaired — worker URL + 6-char pairing code (from the dashboard's
//     "Pair new browser" button) → exchanged for a refresh token via
//     redeemPairingCode() in bridge.js.
//   • Paired — connection status (from the bridge's published relayState),
//     worker URL, access-token expiry, and a "Forget this browser" button
//     that revokes everything and returns to the unpaired view.
//
// MV3 LESSON (kept from the original implementation): state changes are
// driven entirely through chrome.storage — never chrome.runtime.sendMessage,
// which can hang the popup if the service worker's response handling isn't
// perfectly managed across the async boundary. Storage is the durable,
// always-works IPC channel here.
// =============================================================================

import { redeemPairingCode, forgetPairing } from "./bridge.js"
import { isAllowedWorkerOrigin } from "./allowed-origins.js"

const $unpairedView = document.getElementById("unpaired-view")
const $pairedView = document.getElementById("paired-view")
const $url = document.getElementById("worker-url")
const $code = document.getElementById("pair-code")
const $pair = document.getElementById("pair")
const $forget = document.getElementById("forget")
const $status = document.getElementById("status")
const $state = document.getElementById("state")
const $pairedWorkerUrl = document.getElementById("paired-worker-url")
const $pairedExpiry = document.getElementById("paired-expiry")
const $activity = document.getElementById("activity")

async function init() {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) $url.value = workerUrl

  await render()

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.relayState || changes.refreshToken || changes.workerUrl || changes.agentActivity)) {
      render()
    }
  })
  setInterval(render, 2000)
}

async function render() {
  const { refreshToken, workerUrl, accessTokenExpiresAt, relayState, agentActivity } =
    await chrome.storage.local.get([
      "refreshToken",
      "workerUrl",
      "accessTokenExpiresAt",
      "relayState",
      "agentActivity",
    ])

  const paired = !!refreshToken
  $unpairedView.hidden = paired
  $pairedView.hidden = !paired

  if (!paired) return

  $pairedWorkerUrl.textContent = workerUrl || "—"
  if (accessTokenExpiresAt) {
    const minsLeft = Math.max(0, Math.round((accessTokenExpiresAt - Date.now()) / 60000))
    $pairedExpiry.textContent = minsLeft > 0 ? `refreshes in ~${minsLeft}m` : "refreshing…"
  } else {
    $pairedExpiry.textContent = "—"
  }

  // Agent activity — last page opened (shortened) or last CDP command, with
  // how long ago. Published by bridge.js (throttled) on navigations/commands.
  if (agentActivity && (agentActivity.lastUrl || agentActivity.lastCommand)) {
    const ago = agentActivity.at
      ? Math.max(0, Math.round((Date.now() - agentActivity.at) / 60000))
      : null
    const agoText = ago == null ? "" : ago < 1 ? "just now" : `${ago}m ago`
    const what = agentActivity.lastUrl
      ? shortUrl(agentActivity.lastUrl)
      : agentActivity.lastCommand || ""
    $activity.textContent = what
    $activity.title = `${what}${agoText ? ` · ${agoText}` : ""}`
  } else {
    $activity.textContent = "idle"
  }

  const s = relayState || { connected: false }
  if (s.connected) {
    $state.innerHTML =
      '<span class="dot on"></span>connected' +
      (s.activeTabId != null ? " · tab " + s.activeTabId : "")
  } else {
    $state.innerHTML = '<span class="dot off"></span>' + (s.reason || "disconnected")
  }
}

/** https://example.com/jobs/123?q=1 → example.com/jobs/123 (fits the row). */
function shortUrl(url) {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 24 ? u.pathname.slice(0, 24) + "…" : u.pathname
    return u.host + path
  } catch {
    return (url || "").slice(0, 32)
  }
}

// ── Enable Pair once both fields have content. ────────────────────────────
function updatePairButton() {
  $pair.disabled = $url.value.trim().length === 0 || $code.value.trim().length !== 6
}
$url.addEventListener("input", () => {
  updatePairButton()
  clearStatus()
})
$code.addEventListener("input", () => {
  $code.value = $code.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
  updatePairButton()
  clearStatus()
})

function showStatus(msg, kind) {
  $status.textContent = msg
  $status.className = kind // "ok" or "err"
}
function clearStatus() {
  $status.className = ""
  $status.textContent = ""
}

// ── Pair: redeem the code for a refresh token, then the bridge connects. ──
$pair.addEventListener("click", async () => {
  let url = $url.value.trim().replace(/\/+$/, "")
  const code = $code.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) {
    showStatus("URL must start with http:// or https://", "err")
    return
  }
  // Audit (frontend M2): only the allowlisted worker origins may receive the
  // pairing code — anything else is a phishing URL trying to harvest the
  // code + hand back an attacker-controlled refresh token.
  if (!isAllowedWorkerOrigin(url)) {
    showStatus(
      "This worker URL is not allowed. Use the exact URL shown in the dashboard's Connect-browser step.",
      "err",
    )
    return
  }
  $pair.disabled = true
  $pair.textContent = "Pairing…"
  try {
    await redeemPairingCode(url, code)
    showStatus("Paired! Connecting…", "ok")
    // storage.onChanged (refreshToken) in background.js triggers connectRelay.
  } catch (e) {
    showStatus(e?.message || "Pairing failed", "err")
  } finally {
    $pair.disabled = false
    $pair.textContent = "Pair"
    setTimeout(render, 500)
  }
})

// ── Forget: revoke locally + clear storage, back to unpaired view. ────────
// (Server-side revocation of ALL of this user's refresh tokens is available
// via the session-gated POST /api/browser/unpair — surfaced on the dashboard,
// not here, since the extension itself has no session cookie to present.)
$forget.addEventListener("click", async () => {
  $forget.disabled = true
  $forget.textContent = "Forgetting…"
  try {
    await forgetPairing()
    $code.value = ""
    updatePairButton()
    showStatus("Forgotten. This browser is disconnected.", "ok")
  } finally {
    $forget.disabled = false
    $forget.textContent = "Forget this browser"
    setTimeout(render, 300)
  }
})

init()

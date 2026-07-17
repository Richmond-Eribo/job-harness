// =============================================================================
// Popup — sets the worker URL + shows connection state. NO sendMessage.
// =============================================================================
// MV3 LESSON: the previous version saved via chrome.runtime.sendMessage, but
// the service worker's response hung the popup's await ("stuck on
// connecting"). MV3 message channels close if the listener doesn't return true
// AND call sendResponse within the async chain — fragile. Instead we:
//   • Save: write workerUrl straight to chrome.storage.local. background.js's
//     storage.onChanged listener already connects on change — no message needed.
//   • State: the bridge PUBLISHES its connection state to storage.local under
//     `relayState`; the popup reads it with storage.local.get — no message.
// storage is the durable, always-works IPC channel here.
// =============================================================================

const $url = document.getElementById("worker-url")
const $save = document.getElementById("save")
const $disc = document.getElementById("disconnect")
const $status = document.getElementById("status")
const $state = document.getElementById("state")

// ── Load saved URL on open. ────────────────────────────────────────────────
async function init() {
  const { workerUrl } = await chrome.storage.local.get("workerUrl")
  if (workerUrl) {
    $url.value = workerUrl
    $save.disabled = false
  }
  refreshState()
  // Re-read state whenever storage changes (the bridge writes relayState on
  // connect/disconnect) + on a timer as a fallback.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.relayState || changes.workerUrl)) {
      refreshState()
    }
  })
  setInterval(refreshState, 2000)
}

// ── Read connection state from storage (written by the bridge). ───────────
async function refreshState() {
  try {
    const { relayState } = await chrome.storage.local.get("relayState")
    const s = relayState || { connected: false }
    if (s.connected) {
      $state.innerHTML =
        '<span class="dot on"></span>connected' +
        (s.activeTabId != null ? " · tab " + s.activeTabId : "")
    } else {
      $state.innerHTML = '<span class="dot off"></span>' + (s.reason || "disconnected")
    }
  } catch {
    $state.innerHTML = '<span class="dot off"></span>disconnected'
  }
}

// ── Enable Save once there's text. ────────────────────────────────────────
$url.addEventListener("input", () => {
  $save.disabled = $url.value.trim().length === 0
  $status.className = ""
  $status.textContent = ""
})

function showStatus(msg, kind) {
  $status.textContent = msg
  $status.className = kind // "ok" or "err"
}

// ── Save: write storage directly. The SW's onChanged listener connects. ───
// No sendMessage — that was the hang. Writing storage is synchronous-ish and
// never blocks the popup.
$save.addEventListener("click", async () => {
  let url = $url.value.trim().replace(/\/+$/, "")
  if (!url) return
  if (!/^https?:\/\//i.test(url)) {
    showStatus("URL must start with http:// or https://", "err")
    return
  }
  $save.disabled = true
  $save.textContent = "Saving…"
  try {
    await chrome.storage.local.set({ workerUrl: url })
    showStatus("Saved. The service worker is connecting to " + url + "…", "ok")
  } catch (e) {
    showStatus("Failed to save: " + (e?.message || String(e)), "err")
  } finally {
    $save.disabled = false
    $save.textContent = "Save & Connect"
    setTimeout(refreshState, 800)
  }
})

// ── Disconnect: clear the URL + ask the SW to drop the socket. ────────────
// Clearing workerUrl stops auto-reconnect on the next SW wake; the storage
// change also fires the SW's onChanged → disconnectRelay() path.
$disc.addEventListener("click", async () => {
  await chrome.storage.local.set({ workerUrl: null })
  showStatus("Disconnected. URL cleared.", "ok")
  $url.value = ""
  $save.disabled = true
  setTimeout(refreshState, 400)
})

init()

// =============================================================================
// detect.js — content script that lets THIS dashboard know the extension is
// installed (installed ≠ paired ≠ connected — pairing/connection state lives
// on the server; this closes the "is it even installed?" gap).
// =============================================================================
// PRIVACY-BY-MARKER: this script is registered on <all_urls> (host access the
// extension already needs for the relay) but it is a NO-OP on every page
// except ours — it only acts when the page itself declares
// <meta name="agent-harness-site">, which only the dashboard renders. Any
// other site cannot trigger the marker or the ping reply, so the extension
// never reveals its presence to third-party pages (no fingerprinting vector
// beyond our own site).
//
// SIGNALS IT PROVIDES:
//   • document.documentElement.dataset.agentHarnessExt = "<version>" — set
//     once at document_idle; the dashboard polls for it. Chrome injects
//     content scripts into already-open tabs on install, so detection works
//     without a page reload in the common install-then-pair flow. (Reloading
//     the EXTENSION during development does not re-inject — that case needs
//     one dashboard refresh.)
//   • A window.postMessage ping/pong for liveness: the page sends
//     { type: "ah-ext:ping" } and this answers { type: "ah-ext:pong",
//     version }. Origin-validated on both sides; exposes nothing privileged.

(() => {
  try {
    if (!document.querySelector('meta[name="agent-harness-site"]')) return
    const version = chrome.runtime.getManifest().version
    document.documentElement.dataset.agentHarnessExt = version

    window.addEventListener("message", ev => {
      // Only accept messages from this same page (ev.source === window) and
      // this same origin — any other window/origin gets silence.
      if (ev.source !== window) return
      if (ev.origin !== window.location.origin) return
      if (!ev.data || ev.data.type !== "ah-ext:ping") return
      window.postMessage(
        { type: "ah-ext:pong", version },
        window.location.origin,
      )
    })
  } catch {
    // Never let detection break the host page.
  }
})()

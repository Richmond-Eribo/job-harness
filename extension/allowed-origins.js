// =============================================================================
// Allowed worker origins — the ONLY origins this extension will talk to.
// =============================================================================
// AUDIT (frontend M2): the popup previously accepted ANY http(s) URL as the
// "worker URL" and posted the 6-char pairing code there, storing whatever
// refresh token came back. A victim tricked into entering an attacker's URL
// plus a legitimately-minted code handed the attacker the refresh token and
// persistent CDP control of the dedicated agent tab (which carries the
// victim's logins). Enforced at every network touchpoint: popup entry
// (friendly error) AND bridge.js (redeemPairingCode / refreshAccessToken /
// connectRelay — so even a poisoned chrome.storage value can't redirect
// credentials or the WebSocket).
//
// ⚠️ UPDATE ON DEPLOY: replace the placeholder below with YOUR production API
// worker origin (the URL the dashboard's "Connect browser" step displays —
// scheme + host + port, no path, no trailing slash). Local dev origins are
// pre-allowed for wrangler dev.
// =============================================================================

export const ALLOWED_WORKER_ORIGINS = [
  "https://api-job-agent.example.dev", // ← placeholder: set the real prod origin
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]

/**
 * True iff workerUrl's ORIGIN (scheme + host + port) is on the allowlist.
 * Comparison is on the parsed origin, so trailing slashes, casing, and any
 * path component don't matter — but no other origin ever passes.
 */
export function isAllowedWorkerOrigin(workerUrl) {
  try {
    const u = new URL(String(workerUrl).trim().replace(/\/+$/, ""))
    return ALLOWED_WORKER_ORIGINS.includes(u.origin)
  } catch {
    return false
  }
}

# Agent Harness — Browser Relay extension

Connects **your real, logged-in Chrome** to the Agent Harness worker so the
agent can browse login-walled job sites (Indeed, LinkedIn, Glassdoor) using
your existing sessions. This is the free-tier path to reach sites that the
default `fetch()` + HTMLRewriter cannot.

Credentials **never** leave your browser. The agent only ever reads pages you
have already logged into; it never types passwords. If a page needs login, the
agent detects it and stops, prompting you to sign in.

## Install

1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → select this `extension/` folder.
4. On the dashboard, sign in and go to **Settings → Browser & Extension →
   Pair new browser**. This mints a 6-character code that expires in 5
   minutes and can only be used once.
5. Click the extension's toolbar icon → enter your worker URL (e.g.
   `https://agent-harness.<you>.workers.dev`) and the pairing code → **Pair**.

The service worker exchanges the code for a long-lived refresh token (stored
locally, never the raw token shown again), then opens a WebSocket to
`<worker>/browser/relay` authenticated with a short-lived access token. It
silently refreshes that access token before it expires — no re-pairing needed
unless you click **Forget this browser** or the server revokes it.

The extension drives a **dedicated background tab** it creates for itself via
`chrome.debugger` — never your currently active/focused tab. You can keep
browsing normally while a run is in progress.

**Dashboard install detection:** the `detect.js` content script announces the
extension's presence to the dashboard (and only to the dashboard — it no-ops
on every other page unless the page declares `<meta name="agent-harness-site">`).
This is what powers the dashboard's "Extension detected ✓" state during
pairing, distinguishing *installed but unpaired* from *not installed*.

> Publishing to the Chrome Web Store is NOT required for self-hosted use.
> When the product is distributed publicly, see
> `docs/extension-store-publishing.md` — the submission kit (permission
> justifications for the `debugger` permission, privacy notes, packaging)
> is prepared there.

## How it works

```
Worker (relay DO) ◄──WebSocket──► this extension ──chrome.debugger──► dedicated agent tab
```

The agent sends CDP commands (navigate, evaluate, screenshot); the extension
forwards them to `chrome.debugger.sendCommand` on its own background tab and
relays responses back. See `docs/browser-cdp-guide.md` for the full
architecture and `docs/extension-pairing.md` for the pairing/token flow.

## Files

- `manifest.json` — MV3 manifest (`debugger`, `storage`, `tabs`, `alarms`
  permissions).
- `background.js` — service worker: connects on install/startup if already
  paired, reacts to pairing changes.
- `bridge.js` — the WS relay + CDP adapter (frame protocol, heartbeat,
  exponential-backoff reconnect, access-token refresh, pairing exchange,
  per-socket generation guard for in-flight commands).
- `detect.js` — content script: dashboard-only presence detection (see above).
- `popup.html` / `popup.js` — pairing UI (unpaired: code entry; paired:
  status + live agent activity + "Forget this browser").
- `icon.png` — toolbar icon (replace with a real 128×128).

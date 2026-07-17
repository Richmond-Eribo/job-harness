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
4. Click the extension's toolbar icon → enter your worker URL
   (e.g. `https://agent-harness.<you>.workers.dev`) → Save.

The service worker opens a WebSocket to `<worker>/browser/relay` and attaches
`chrome.debugger` to your active tab. Keep a tab open and focused while the
agent browses.

## How it works

```
Worker (relay DO) ◄──WebSocket──► this extension ──chrome.debugger──► your tab
```

The agent sends CDP commands (navigate, evaluate, screenshot); the extension
forwards them to `chrome.debugger.sendCommand` and relays responses back. See
`docs/browser-cdp-guide.md` for the full architecture.

## Files

- `manifest.json` — MV3 manifest (`debugger`, `storage`, `tabs` permissions).
- `background.js` — service worker: connects the WS on install/startup, listens
  for worker-URL changes.
- `bridge.js` — the WS relay + CDP adapter (frame protocol, heartbeat,
  reconnect).
- `icon.png` — toolbar icon (replace with a real 128×128).

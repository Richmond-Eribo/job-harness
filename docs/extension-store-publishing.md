# Publishing the Browser Relay extension to the Chrome Web Store

**Current status: NOT published — the supported install path is unpacked
(self-hosted, see `extension/README.md`).** This document is the prepared
submission kit for when the product is distributed to non-technical users,
because unpacked install (Developer mode → Load unpacked) shows a Chrome
startup nag ("Disable developer mode extensions") and is too error-prone for
end users.

## When publishing is (not) required

| Situation | Requirement |
|---|---|
| Self-hosted / repo users (today) | **Not required.** Unpacked install works; the nag banner is the only cost. |
| Public beta with link-sharing | Optional. An **unlisted** listing removes the dev-mode nag and gives one-click install; same review as public. |
| Non-technical public users | **Required.** Store install is the only friction-free path. |

## What to expect from review

Our manifest requests two things Google flags for **in-depth review**:

1. The **`debugger`** permission (sensitive "execution" permission — grants
   Chrome DevTools Protocol access). RPA/automation tools (UiPath, Tricentis)
   prove it's approvable; expect days-to-weeks and a manual code inspection.
2. **Broad host permissions** (`<all_urls>`) — needed because the agent
   navigates arbitrary job sites and the detection content script is
   registered globally (it self-disables everywhere except our dashboard).

Practical tips from the ecosystem: submit a small proof-of-concept first if
possible, don't resubmit while pending, avoid minified/obfuscated builds in
the reviewed version, and record a short demo video — it's the most commonly
cited way to get through appeal or support review.

## Submission checklist

- [ ] $5 one-time developer registration fee (developer dashboard).
- [ ] 2-Step Verification enabled on the Google account (mandatory since 2024).
- [ ] Privacy policy URL. Safe draft: the extension collects **no** PII,
      credentials never leave the user's browser; the relay transports CDP
      commands between the user's own Chrome and their own deployment of this
      worker; pages visited are job sites the user's agent is configured to
      browse.
- [ ] Single-purpose statement (see draft below).
- [ ] Permission justifications (see drafts below — the dashboard has a field
      per permission).
- [ ] Demo video URL (private/unlisted YouTube is fine): pairing a browser,
      the agent reading a login-walled job page, the "started debugging this
      browser" banner appearing **only on the dedicated background tab**.
- [ ] Screenshots (1280×800) + a 440×280 promo tile; store listing copy.
- [ ] Zip of the `extension/` folder (see "Packaging" below).
- [ ] Decide listing visibility: Public vs **Unlisted** (link-only).

## Draft single-purpose statement

> Lets the user's own job-search agent (a self-hosted Cloudflare Worker the
> user pairs with) read and interact with web pages in a dedicated browser
> tab, using the user's existing logins. The extension is a relay: it
> executes navigation/reading commands sent by the user's own deployment over
> an authenticated WebSocket, so the agent can browse login-walled job
> listings without the user sharing passwords with any server.

## Draft permission justifications

- **debugger** — attaches the Chrome DevTools Protocol to ONE dedicated
  background tab the extension itself opens, and only to translate commands
  from the user's paired agent into page navigation/reading. It is never
  attached to the user's other tabs, never intercepts keystrokes on pages the
  user browses, and no lesser API can navigate + read pages in a background
  tab (chrome.scripting cannot produce real key events or read pages
  reliably; we deliberately do NOT use it).
- **tabs** — creates/reuses the single dedicated agent tab and reacts when
  the user closes it.
- **storage** — stores the pairing refresh token and worker URL locally;
  nothing else.
- **alarms** — a 30s watchdog that re-establishes the relay WebSocket after
  Chrome evicts the background service worker (MV3 lifecycle).
- **host permissions (`<all_urls>`)** — job sites are user-configured and
  arbitrary, so navigation cannot be limited to a fixed host list. The
  registered content script (`detect.js`) is a no-op on every site except the
  user's own dashboard (it gates on a meta tag our dashboard renders) and
  exposes only an installed/not-installed signal — no page content is read by
  it.

## Packaging

From the repo root (the zip must contain the files directly, not a nested
folder):

```
cd extension && zip -r ../job-harness-relay-vX.Y.Z.zip . -x README.md
```

Bump `manifest.json` version, re-zip, upload to the developer dashboard, and
paste the justifications above. **After approval:** set
`distribution.mode: "store"` and `distribution.storeUrl` in
`packages/hono-worker/src/config/browser-config.json` — the dashboard's
ConnectBrowserCard switches its Install step from the unpacked walkthrough to
an "Add to Chrome" link automatically (served via `GET /api/browser/status`).

## If rejected

Use the **Appeal** button on the item page in the developer dashboard, or the
[One Stop Support form](https://support.google.com/chrome_webstore/contact/one_stop_support).
Attach the demo video and the justifications verbatim. The most common
rejection cause for `debugger`-based extensions is an unconvincing
justification, not the permission itself.

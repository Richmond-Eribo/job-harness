# Browser (CDP) Capability — Design Guide

> Status: **Design** (no code written yet). This document captures the full
> architecture for giving the agent a real browser so it can reach
> login-walled job sites (Indeed, LinkedIn, Glassdoor) that the current
> unauthenticated `fetch()` + `HTMLRewriter` path cannot.
>
> Supersedes the in-chat design from session `sess_90b62a7b`. Decisions here
> are locked; implementation follows in phases.

## 1. The problem

The current job-discovery path (`src/agents/job-agent.ts` → `fetchAndParse`)
issues a single unauthenticated `fetch()` with a `job-agent/1.0` User-Agent
and parses the response HTML with `HTMLRewriter`. This fails on three
independent fronts for sites like Indeed, LinkedIn, and Glassdoor:

| Front | What happens |
|---|---|
| **Bot detection** | They fingerprint the request (TLS/JA3, headers, behavior). A bare Worker `fetch()` doesn't look like a browser → 403 or a JS-challenge page. |
| **Login wall** | Listings sit behind auth. No session cookies = no jobs, just a login redirect. |
| **JS-rendered content** | Even logged in, many listings are populated by client-side JS after load. `HTMLRewriter` only sees the initial (often empty) HTML. |

No single tweak fixes all three. The agent needs a **real browser** — real
TLS fingerprint, real cookie jar, real JS execution. This doc defines how it
gets one.

## 2. Mental-model corrections (why the obvious things don't work)

Three things people reach for first, and why each is wrong here:

### 2a. "Just spawn Chromium on the Worker"

**A Cloudflare Worker is a V8 isolate.** It has no `child_process`, no
filesystem, no ability to launch a process. You cannot run Chromium from
inside a Worker, period. The only way to get a browser is a *managed* one
Cloudflare provides (Browser Rendering) or one *you* run elsewhere.

### 2b. "Use Cloudflare Browser Rendering with a browser extension loaded"

Cloudflare Browser Rendering **does not accept `--load-extension` flags.**
It's a managed, locked-down Chromium that exposes the Chrome DevTools
Protocol (CDP) over WebSocket but won't load arbitrary extensions. So the
extension pattern (which exists to reach a browser you don't fully control)
adds nothing against the managed browser — you already have raw CDP there.

### 2c. "Headless browser + extension together"

These solve **different** problems and target **different** browsers. The
extension pattern is for reaching a browser *behind NAT* that you don't
control (the user's real Chrome). If you control the headless browser, you
have direct CDP. Combining them is redundant.

**The resolution:** treat the browser as a *target* the agent speaks CDP to.
There are two valid targets, and the agent code should not care which is
active. That abstraction is the whole point of the relay DO (§4).

## 3. CDP, Playwright, and the relay — mechanics

### 3.1 Chrome DevTools Protocol (CDP)

The low-level wire protocol Chromium speaks. Every browser action (navigate,
click, evaluate JS, get the DOM tree, take a screenshot) is a JSON message
over a WebSocket. Playwright and Puppeteer are high-level libraries that
speak CDP for you. The agent will speak CDP (or a thin wrapper) so it can
target *either* browser without depending on Playwright being available
inside the Worker isolate.

### 3.2 Managed target — Cloudflare Browser Rendering

- Binding: `[[browser]]` in `wrangler.jsonc` + the `@cloudflare/playwright`
  package.
- Gives a `pw.Browser` object in the Worker that drives a Cloudflare-hosted
  Chromium over CDP.
- **Always available**, no extension, no client-side dependency.
- **Cannot reach login-walled content** — it has no session cookies. It's a
  fresh browser every time.
- **Requires a paid Workers plan** (not free-tier). This is the constraint
  that makes it Phase 2, not Phase 1, for a free-tier-first project.

### 3.3 Live target — your real Chrome via a relay extension

- A Chrome extension (manifest v3) uses the `chrome.debugger` API to attach
  to the user's own browser tab and speaks CDP.
- The extension opens an **outbound** WebSocket to a relay Durable Object
  (the browser can reach the Worker; the Worker cannot reach the browser
  behind NAT — hence outbound).
- The relay DO bridges agent CDP commands → extension → real browser, and
  browser events → extension → relay → agent.
- **Reaches login-walled content** because it *is* the user's logged-in
  browser. Indeed/LinkedIn work because the user is already signed in.
- **Free-tier compatible** — it's just a WebSocket relay in a DO.
- **Requires the user's browser to be running** and the extension connected.
  When the browser is offline, the agent falls back to managed (if configured)
  or skips browser-dependent steps.

### 3.4 Data flow (hybrid)

```
Agent (harness / browser-agent DO)
  │
  │  (CDP commands as JSON: navigate, observe, act, extract)
  │
  ▼
BrowserRelay DO  ◄──────────── chooses target ────────────┐
  │                                                      │
  │ target = "live"                                      │ target = "managed"
  ▼                                                      ▼
outbound WS                                        @cloudflare/playwright
  │                                                binding (pw.Browser)
  ▼                                                      │
Chrome extension                                          ▼
(chrome.debugger)                                  Cloudflare-hosted
  │                                                Chromium (fresh, no login)
  ▼
User's real Chrome
(logged-in sessions:
 Indeed, LinkedIn, …)
```

The relay DO holds a flag: `live` (extension connected) or `managed`
(playwright binding present) or `none`. The agent asks the relay "which
target is active?" and either proceeds or reports that no browser is
available.

## 4. Architecture — the hybrid relay Durable Object

A single `BrowserRelay` DO per harness instance. It:

1. **Accepts an outbound WebSocket from the extension** (the "live" target
   connecting in).
2. **Optionally holds a `pw.Browser` session** (the "managed" target,
   lazily created on first use).
3. **Exposes a `sendCdp(method, params)` RPC** to the agent that routes to
   whichever target is active, and a `targetKind()` RPC the agent probes
   before issuing commands.
4. **Forwards CDP responses + browser events** back to the agent.

This is the only piece that knows which browser it's talking to. Everything
above it (the `BrowserAgent`, the tools, the harness) sees one uniform CDP
interface.

### 4.1 Why a DO (not a Worker route)

- The extension's outbound WebSocket is a **long-lived connection**. Only a
  Durable Object can hold one open across requests. A Worker handler would
  drop it on return.
- The relay holds **connection state** (which extension is connected, the
  active tab id) that must persist between agent calls — that's DO storage.
- The `@cloudflare/playwright` session is also stateful and benefits from
  co-location with the relay logic.

## 5. Text-only model support (the `vision` flag)

The configured model (`GLM-5.2`) is text-only. A text-only model cannot
"look" at a screenshot and decide where to click. The browser tools must
work **without vision** by default, with vision as an opt-in upgrade.

### 5.1 Structure-based interaction (primary, no vision)

- **`browser_observe`** returns the page as a compact **accessibility-tree
  YAML** with refs (the token-efficiency pattern proven by Playwright MCP —
  structure only, no full page text):
  ```yaml
  - heading "Sign in" [level=1]
  - textbox "Email" [ref=e4]
  - button "Sign in" [ref=e7]
  ```
  Interactive nodes get a `data-ref` attribute stamped in the DOM so act()
  can resolve them. The whole tree is capped (`snapshot.maxChars` /
  `maxElements` in browser-config.json).
- **`browser_read`** is the lazy companion: it pulls the TEXT the model
  actually needs — a specific element (`{elementRef:"e4"}`) or the main
  content region (no args) — instead of shipping body text on every observe.
- **`browser_act`** takes **semantic actions keyed by elementRef**, not
  coordinates:
  ```json
  {"action": "click", "elementRef": "e7"}
  {"action": "type",  "elementRef": "e4", "text": "..."}
  {"action": "press", "key": "Enter"}
  ```
- The agent resolves `elementRef` → real node → CDP action internally
  (clicks fall back to re-resolving role+name when an SPA re-render wiped
  the attribute; press/type use REAL CDP input events — Enter submits
  forms). The model never sees raw CDP or coordinates.

### 5.2 Vision mode (opt-in)

- Controlled by **`"vision": false`** (default) in `src/config/llm-config.json`.
- When `true`, `browser_observe` *also* returns a base64 PNG screenshot, and
  `browser_act` accepts `{"action":"click","x":..,"y":..}` coordinate clicks.
- This flag controls **tool behavior**, not model selection. Switching it on
  without a vision-capable model makes the screenshot useless to the model
  but doesn't break anything.

| `vision` | `browser_observe` returns | `browser_act` accepts |
|---|---|---|
| `false` (default) | a11y tree YAML (+ `browser_read` for text) | `{action, elementRef}` |
| `true` | tree **+ base64 screenshot** | `{action, elementRef}` **or** `{action, x, y}` |

## 6. Credentials safety (non-negotiable)

**Credentials never touch our system.** This is a hard design rule, not a
preference:

- No password / username / token fields in **any** tool schema, DB table, or
  trace log.
- The agent **assumes the user is already logged in** in their real browser
  (the live-target path). It never performs a login itself.
- **`browser_observe` detects login walls** and **stops**:
  - Triggers on known login-wall URL patterns (e.g. `/login`, `/auth`,
    `/signin`, `/account/login`) **or** the presence of
    `<input type="password">` on the page.
  - When detected, the tool returns a structured result like
    `{"status":"login_required","url":"…","prompt":"This page requires login. Open it in your browser and sign in, then retry."}`
    and **takes no further action**.
- This keeps the agent out of credential-handling scope entirely: it only
  ever reads pages the user has already unlocked. If a page needs login and
  isn't unlocked, the human is prompted — the agent waits.

## 7. Open-source references

These are study material, not dependencies to vendor-lock onto:

| Project | Role | Why relevant |
|---|---|---|
| **AnswerDotAI/solveit-chrome** | Simplest complete extension example | `background.js` (service worker) manages `chrome.debugger`; `bridge.js` relays CDP; events `cdp-new-tab`/`cdp-send`/`cdp-subscribe`. Easiest end-to-end to study. |
| **browserbase/ModCDP** | Chrome extension → WS → local proxy → standard CDP endpoint | Reverse-WebSocket mode (`--upstream-mode=reversews`). Uses `chrome.debugger` + `chrome.*` APIs. Heavier than solveit; good for the relay mechanics. |
| **cyrus-and/chrome-remote-interface** | CDP client library reference | Canonical Node CDP client; useful for the wire format even though we run in a Worker. |
| **browserbase/stagehand** | `observe`/`act`/`extract` agent pattern | The exact tool shape we adopt (§5). |
| **browser-use** | Accessibility-tree agent control | Text-only mode reference; confirms a11y-tree driving works without vision. |

## 8. Extension points — where the code plugs in

| File | What to add |
|---|---|
| `wrangler.jsonc` | New DO bindings `BROWSER_AGENT`, `BROWSER_RELAY`; add both to `new_sqlite_classes` migration; `[[browser]]` binding (managed target, paid plan). |
| `src/index.ts` | Re-export `BrowserAgent`, `BrowserRelay`; add a WS upgrade route for the extension to connect to the relay. |
| `src/types/env.ts` | `BROWSER_AGENT: DurableObjectNamespace<BrowserAgent>` and `BROWSER_RELAY: DurableObjectNamespace<BrowserRelay>`; optional `BROWSER: Fetcher` for the managed binding. |
| **New** `src/agents/browser-agent.ts` | Modeled on `src/agents/research-agent.ts` — `Agent<Env>`, `@callable()` methods, an internal LLM loop with `observe`/`act`/`extract` tools. Branches on the `vision` flag. Buffers trace events (uses the shared `TraceRecorder` from §recent observability work) and returns them on the RPC for nesting under the calling tool. |
| **New** `src/agents/browser-relay.ts` | The `BrowserRelay` DO — accepts the extension's outbound WS, lazily creates a `pw.Browser` for the managed path, exposes `sendCdp()`/`targetKind()` RPCs, forwards CDP + browser events. |
| **New** `src/tools/browser.tool.ts` | Delegation tools `browser_navigate`, `browser_observe`, `browser_act`, `browser_extract` — modeled on the existing `src/tools/jobs.tool.ts` pattern (`getAgentByName` + `withRpcRetry` + `runIdRef` for trace attribution). |
| `src/tools/index.ts` | Register the browser tools in `buildAgentTools()`. |
| `src/config/llm-config.json` | Add `"vision": false`. |
| **New** `extension/` | The Chrome extension (manifest v3): `background.js` (service worker, `chrome.debugger`), `bridge.js` (WS relay), `manifest.json`. Connects to the relay DO's WS upgrade route. |

## 9. Phased rollout

### Phase 1 — Managed headless (read/extract only)
- `BrowserAgent` DO + `browser_navigate` / `browser_observe` /
  `browser_extract` tools.
- `[[browser]]` binding + `@cloudflare/playwright`.
- **No login-walled access** (managed browser is sessionless) — but unblocks
  JS-rendered open sites and proves the agent↔browser↔CDP loop.
- **Paid plan required.**

### Phase 2 — Extension relay (live sessions)
- `BrowserRelay` DO + the Chrome extension.
- The agent's CDP calls now route to the user's real, logged-in browser.
- Indeed/LinkedIn/Glassdoor work because **the user is signed in**.
- Free-tier compatible. Requires the browser running + extension connected.
- Login-wall detection (§6) ships here — the agent stops and prompts when a
  page needs login it doesn't have.

### Phase 3 — Full interaction (`browser_act`)
- Click / type / submit with the domain allow-list and safety guards.
- `vision` flag becomes meaningful (coordinate clicks for vision models).
- Structure-based actions (default) work for text-only models throughout.

### Phase 4 — Target auto-selection
- The relay reports `live` / `managed` / `none`; the harness picks the best
  available target per call. Fully realizes the hybrid design: logged-in
  sites via the extension when the browser is up, managed headless as
  fallback for open sites, graceful skip when neither is available.

## 10. What this does NOT do

- **No credential storage.** Ever. (§6)
- **No breaking the free-tier stance by default.** Phase 1 (managed) needs
  paid; Phase 2 (relay) does not. A free-tier deployment runs Phase 2 only.
- **No replacing the existing scrape path.** `fetchAndParse` stays for open
  sources; the browser is a new capability for sites that need it. The
  `job_sources` table may later gain a `kind` column to route per source,
  but that's a future decision, not part of this design.

## 11. Open questions for implementation

1. **CDP library in the Worker.** `@cloudflare/playwright` covers the managed
   path. For the relay path (talking to the extension's CDP), we either use
   the same Playwright over a custom transport, or speak raw CDP JSON over
   the relay WS. Raw CDP is lighter and target-agnostic — lean toward that,
   with Playwright only for the managed target.
2. **Element-ID stability.** The a11y-tree element IDs must be stable across
   `observe` → `act` calls within one page load. CDP's `DOM.describeNode`
   with a per-session counter works; confirm across navigations.
3. **Rate / cost.** A browser session is far heavier than a `fetch()`. The
   harness's existing `maxSteps` and token budget bound LLM cost but not
   browser cost — a separate per-run browser-action cap may be needed.

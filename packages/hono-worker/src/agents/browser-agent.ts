// =============================================================================
// BrowserAgent — drives a browser (via the relay) to read login-walled pages.
// =============================================================================
// The harness calls browser_navigate / browser_observe / browser_act /
// browser_read / browser_extract (delegation tools in src/tools/browser.tool.ts);
// those RPC into THIS agent. This agent speaks CDP to the BrowserRelay, which
// routes to the user's real logged-in Chrome (live) or the managed headless
// Chromium.
//
// TEXT-ONLY MODEL SUPPORT
// The configured model is text-only. So observe() returns the page as a
// compact ACCESSIBILITY-TREE YAML (roles + names + refs like [ref=e5]) — the
// token-efficiency pattern proven by Playwright MCP (~2-5 KB per page, vs
// 10-100x for HTML/DOM dumps). Full page text is NOT included by default:
// browser_read(ref?) lazily pulls the text of a specific node or the main
// content region, so the model only pays tokens for what it actually needs.
// A vision flag (llm-config.json → browser.vision) optionally adds
// screenshots + coordinate clicks — but the default path needs no vision.
//
// ACT FIDELITY
// Real CDP input events, not synthetic DOM events: press() dispatches
// Input.dispatchKeyEvent (a synthetic KeyboardEvent does NOT trigger browser
// defaults — Enter would not submit a form), and type() focuses + selects
// then uses Input.insertText (works for React inputs AND contenteditable).
// Clicks resolve by data-ref, falling back to re-resolving role+name from
// the last snapshot when an SPA re-render wiped the attribute.
//
// CREDENTIALS SAFETY (non-negotiable)
// observe() detects login walls (URL patterns + password inputs) and STOPS —
// returning a login_required status that the caller surfaces to the operator.
// The agent NEVER attempts to log in itself and NEVER handles credentials.
//
// TRACE
// Uses the shared TraceRecorder so browser activity nests under the calling
// harness tool in the transcript (same buffer+return pattern as the job agent).
// =============================================================================

import { Agent, callable } from "agents"
import { generateText } from "ai"
import { getModel, getParams } from "../llm"
import type { Env } from "../types"
import { TraceRecorder } from "../utils/trace-recorder"
import browserConfig from "../config/browser-config.json"
import llmConfig from "../config/llm-config.json"
import { getAgentByName } from "agents"

// -----------------------------------------------------------------------------
// Config (see browser-config.json → safety / snapshot / managed)
// -----------------------------------------------------------------------------
const SAFETY = (browserConfig as any).safety ?? {}
const LOGIN_PATTERNS: string[] = SAFETY.loginWallUrlPatterns ?? []
const LOGIN_SELECTORS: string[] = SAFETY.loginWallInputSelectors ?? []

const SNAPSHOT_CFG = (browserConfig as any).snapshot ?? {}
const SNAPSHOT_MAX_CHARS: number = SNAPSHOT_CFG.maxChars ?? 6000
const SNAPSHOT_MAX_ELEMENTS: number = SNAPSHOT_CFG.maxElements ?? 120
const READ_MAX_CHARS: number = SNAPSHOT_CFG.readMaxChars ?? 4000
const WAIT_AFTER_LOAD_MS: number = SNAPSHOT_CFG.waitForLoadMs ?? 600
const NAV_TIMEOUT_MS: number =
  (browserConfig as any).managed?.navigationTimeoutMs ?? 30000

interface PageSnapshot {
  url: string
  title: string
  /** Compact accessibility-tree YAML: `- link "Apply now" [ref=e5]` lines. */
  tree: string
  /** true when the tree hit its maxChars/maxElements budget. */
  truncated: boolean
  /** base64 PNG screenshot — only when vision mode is on. */
  screenshot?: string
}

interface ObserveResult {
  loginRequired?: boolean
  prompt?: string
  page?: PageSnapshot
}

// -----------------------------------------------------------------------------
// BrowserAgent DO
// -----------------------------------------------------------------------------

interface BrowserAgentState {
  initialized: boolean
}

export class BrowserAgent extends Agent<Env, BrowserAgentState> {
  initialState: BrowserAgentState = { initialized: false }

  // ref → {role, name} from the LAST snapshot. Used to re-resolve an element
  // by role+name when an SPA re-render wiped its data-ref attribute (React
  // re-renders drop unknown attributes). Transient — survives only this DO
  // instance's lifetime, which matches the snapshot it describes.
  private lastRefs = new Map<string, { role: string; name: string }>()

  // getAgentByName returns a DurableObjectStub proxy exposing the @callable()
  // methods; cast to any to avoid the SDK's deep generic instantiation on the
  // stub type. The relay's method signatures (sendCdp/targetKind/observe/act)
  // are stable.
  //
  // Multi-tenant: the relay is resolved by THIS agent's name (this.name), which
  // is the userId — so the agent drives the SAME user's Chrome connection it
  // was resolved for. The DO name threads the user identity down the chain.
  private async relay(): Promise<any> {
    const stub = await (getAgentByName as any)(
      this.env.BROWSER_RELAY,
      this.name,
    )
    return stub
  }

  // -------------------------------------------------------------------------
  // Low-level CDP helpers — talk to the relay, which talks to the browser.
  // -------------------------------------------------------------------------

  /** Enable the CDP domains we need for a fresh navigation. */
  private async primeCdp(): Promise<void> {
    const relay = await this.relay()
    // Enable Page + Runtime + DOM so navigation + eval + querying work.
    await relay.sendCdp("Page.enable")
    await relay.sendCdp("Runtime.enable")
    await relay.sendCdp("DOM.enable")
  }

  /** Small CDP eval that returns a string result value (or null). */
  private async evalString(relay: any, expression: string): Promise<string | null> {
    const res: any = await relay.sendCdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    return res?.result?.value ?? null
  }

  // -------------------------------------------------------------------------
  // Core RPCs the delegation tools call.
  // -------------------------------------------------------------------------

  /** Navigate the active browser tab to a URL and wait for load. */
  @callable()
  async navigate(url: string): Promise<{ url: string; title: string; ok: boolean; error?: string }> {
    try {
      const relay = await this.relay()
      if (relay.targetKind() === "none") {
        return {
          url,
          title: "",
          ok: false,
          error:
            "No browser target connected. Open the dashboard → Browser and connect the extension.",
        }
      }
      await this.primeCdp()
      await relay.sendCdp("Page.navigate", { url })
      // Wait for the document to actually reach 'complete' (bounded), then a
      // short settle for SPA post-load renders. The old fixed 2.5s sleep was
      // both too slow for fast pages and too fast for heavy ones.
      const deadline = Date.now() + Math.min(10000, NAV_TIMEOUT_MS)
      while (Date.now() < deadline) {
        const state = await this.evalString(relay, "document.readyState")
        if (state === "complete") break
        await new Promise(r => setTimeout(r, 200))
      }
      await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD_MS))
      const title = (await this.evalString(relay, "document.title")) ?? ""
      return { url, title, ok: true }
    } catch (e: any) {
      return { url, title: "", ok: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * Observe the current page: return a compact accessibility-tree snapshot
   * (text-only). Detects login walls and STOPS — never attempts login.
   * Returns { loginRequired: true, prompt } when a wall is detected.
   */
  @callable()
  async observe(): Promise<ObserveResult> {
    try {
      const relay = await this.relay()
      if (relay.targetKind() === "none") {
        return {
          loginRequired: false,
          prompt:
            "No browser target connected. Connect the extension from the dashboard Browser panel.",
        }
      }
      await this.primeCdp()

      // URL + title + login-wall detection, evaluated in one round trip.
      const evalRes: any = await relay.sendCdp("Runtime.evaluate", {
        expression: `(() => {
          const url = location.href;
          const title = document.title;
          const hasPassword = ${JSON.stringify(LOGIN_SELECTORS)}
            .some(sel => document.querySelector(sel) != null);
          const isLoginUrl = ${JSON.stringify(LOGIN_PATTERNS)}
            .some(p => url.toLowerCase().includes(p));
          return JSON.stringify({ url, title, hasPassword, isLoginUrl });
        })()`,
        returnByValue: true,
      })
      const meta = JSON.parse(evalRes?.result?.value ?? "{}")
      if (meta.hasPassword || meta.isLoginUrl) {
        return {
          loginRequired: true,
          prompt:
            `This page (${meta.url}) requires login. Open it in your connected Chrome, ` +
            `sign in, then retry. The agent never logs in on your behalf.`,
        }
      }

      // Build the accessibility-tree snapshot for the model.
      const page = await this.snapshotPage(relay, meta.url, meta.title)
      return { page }
    } catch (e: any) {
      return { prompt: `observe failed: ${e?.message ?? String(e)}` }
    }
  }

  /**
   * Snapshot the page into a compact accessibility-tree YAML: role-named
   * nodes (`- link "Apply now" [ref=e5]`, `- heading "Details" [level=2]`,
   * `- text: "…"`), capped by snapshot.maxChars / maxElements. Interactive
   * nodes get a data-ref attribute stamped in the DOM so act() can resolve
   * them; refs are stable only within a snapshot — the model must re-observe
   * after any act() that may change the DOM.
   */
  private async snapshotPage(
    relay: any,
    url: string,
    title: string,
  ): Promise<PageSnapshot> {
    const vision = !!((llmConfig as any).browser?.vision ?? false)
    // One eval: walk the DOM, emit the tree, stamp data-ref attributes, and
    // return ref metadata so act() can re-resolve after SPA re-renders.
    const evalRes: any = await relay.sendCdp("Runtime.evaluate", {
      expression: `(() => {
        const MAX_CHARS = ${SNAPSHOT_MAX_CHARS};
        const MAX_EL = ${SNAPSHOT_MAX_ELEMENTS};
        const lines = [];
        const refs = {};
        let n = 0, truncated = false;

        const isHidden = (el) => {
          if (el.getAttribute('aria-hidden') === 'true') return true;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return true;
          const s = window.getComputedStyle(el);
          return s.display === 'none' || s.visibility === 'hidden';
        };

        const clean = (t, max) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, max);

        const roleOf = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'a' && el.getAttribute('href') != null) return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
            if (t === 'checkbox' || t === 'radio') return t;
            return 'textbox';
          }
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          return null;
        };

        const interactive = (role, el) =>
          role === 'link' || role === 'button' || role === 'textbox' ||
          role === 'combobox' || role === 'checkbox' || role === 'radio' ||
          role === 'tab' || role === 'option' || role === 'menuitem' ||
          role === 'switch' || role === 'searchbox';

        const nameOf = (el) => {
          const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
          return clean(
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('title') ||
            el.getAttribute('alt') ||
            label ||
            el.innerText ||
            el.value,
            80,
          );
        };

        const overBudget = () => lines.join('\\n').length >= MAX_CHARS || lines.length >= MAX_EL;

        const walk = (el, depth) => {
          if (truncated) return;
          for (const child of Array.from(el.children)) {
            if (truncated) return;
            const tag = child.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') continue;
            const role = roleOf(child);
            const isText = tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'figcaption';
            if (!role && !isText) {
              // structural container — don't emit, just descend
              walk(child, depth + 1);
              continue;
            }
            if (isHidden(child)) continue;
            const indent = '  '.repeat(Math.min(depth, 8));
            if (role === 'heading') {
              const level = child.tagName.toLowerCase()[1];
              lines.push(indent + '- heading "' + clean(child.innerText, 80) + '" [level=' + level + ']');
            } else if (role === 'img') {
              const name = clean(child.getAttribute('alt') || child.getAttribute('title') || '', 80);
              if (name) lines.push(indent + '- img "' + name + '"');
            } else if (isText && !role) {
              const text = clean(child.innerText, 160);
              if (text) lines.push(indent + '- text: ' + JSON.stringify(text));
            } else if (role) {
              const name = nameOf(child);
              if (!name && !interactive(role, child)) continue;
              let refPart = '';
              if (interactive(role, child)) {
                n += 1;
                const ref = 'e' + n;
                child.setAttribute('data-ref', ref);
                refs[ref] = { role: role, name: name };
                refPart = ' [ref=' + ref + ']';
              }
              if (name) {
                lines.push(indent + '- ' + role + ' ' + JSON.stringify(name) + refPart);
              } else {
                lines.push(indent + '- ' + role + refPart);
              }
            }
            if (overBudget()) { truncated = true; return; }
            walk(child, depth + 1);
          }
        };

        const body = document.body;
        if (body) walk(body, 0);
        if (truncated) lines.push('- (snapshot truncated — use browser_read for more)');
        return JSON.stringify({
          tree: lines.join('\\n'),
          refs: refs,
          truncated: truncated,
        });
      })()`,
      returnByValue: true,
    })
    const parsed = JSON.parse(evalRes?.result?.value ?? "{}")
    this.lastRefs = new Map(
      Object.entries(parsed.refs ?? {}).map(([ref, meta]: [string, any]) => [
        ref,
        { role: String(meta?.role ?? ""), name: String(meta?.name ?? "") },
      ]),
    )
    const snap: PageSnapshot = {
      url,
      title,
      tree: String(parsed.tree ?? ""),
      truncated: !!parsed.truncated,
    }
    if (vision) {
      try {
        // Capture screenshot via CDP (works for both targets).
        const shot: any = await relay.sendCdp("Page.captureScreenshot", {
          format: "png",
        })
        if (shot?.data) snap.screenshot = shot.data
      } catch {
        // screenshot optional — structure path still works
      }
    }
    return snap
  }

  /**
   * Lazily read page text — the token-saving companion to observe(). Without
   * a ref, returns the main content region's innerText (main/[role=main]/
   * article/body fallback). With a ref from the last observe, returns that
   * node's text. Truncated to snapshot.readMaxChars.
   */
  @callable()
  async read(elementRef?: string): Promise<{ text: string; truncated: boolean; error?: string }> {
    try {
      const relay = await this.relay()
      if (relay.targetKind() === "none") {
        return { text: "", truncated: false, error: "No browser target connected." }
      }
      await this.primeCdp()
      const max = READ_MAX_CHARS

      if (elementRef) {
        const byRef = await this.evalString(
          relay,
          `(() => {
            const el = document.querySelector('[data-ref=${JSON.stringify(elementRef)}]');
            if (!el) return null;
            const t = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
            return JSON.stringify({ t: t.slice(0, ${max}), more: t.length > ${max} });
          })()`,
        )
        if (byRef != null) {
          const parsed = JSON.parse(byRef)
          return { text: parsed.t, truncated: !!parsed.more }
        }
        // Ref wiped by a re-render — re-resolve by role+name from lastRefs.
        const meta = this.lastRefs.get(elementRef)
        if (meta?.name) {
          const byName = await this.evalString(
            relay,
            `(() => {
              const cands = document.querySelectorAll('a, button, input, select, textarea, [role]');
              const want = ${JSON.stringify(meta.name)}.toLowerCase();
              for (const el of cands) {
                const t = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
                if (t && t.toLowerCase().includes(want)) {
                  const full = t;
                  return JSON.stringify({ t: full.slice(0, ${max}), more: full.length > ${max} });
                }
              }
              return null;
            })()`,
          )
          if (byName != null) {
            const parsed = JSON.parse(byName)
            return { text: parsed.t, truncated: !!parsed.more }
          }
        }
        return {
          text: "",
          truncated: false,
          error: `Element ${elementRef} not found — call browser_observe for a fresh snapshot.`,
        }
      }

      // Main content region.
      const main = await this.evalString(
        relay,
        `(() => {
          const el = document.querySelector('main, [role="main"], article, #content, .content') || document.body;
          const t = (el && el.innerText ? el.innerText : '').replace(/\\s+/g, ' ').trim();
          return JSON.stringify({ t: t.slice(0, ${max}), more: t.length > ${max} });
        })()`,
      )
      const parsed = JSON.parse(main ?? "{}")
      return { text: String(parsed.t ?? ""), truncated: !!parsed.more }
    } catch (e: any) {
      return { text: "", truncated: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * Act on the page: click an element, type into it, scroll, or press a key.
   * elementRef-based actions resolve via the data-ref attribute observe()
   * stamped; when an SPA re-render wiped it, click/type re-resolve by
   * role+name from the last snapshot. Coordinate clicks only when vision
   * mode is on.
   */
  @callable()
  async act(action: {
    action: "click" | "type" | "scroll" | "press" | "wait"
    elementRef?: string
    text?: string
    key?: string
    x?: number
    y?: number
    ms?: number
  }): Promise<{ ok: boolean; resolvedVia?: "ref" | "fallback"; error?: string }> {
    try {
      const relay = await this.relay()
      await this.primeCdp()
      switch (action.action) {
        case "wait":
          await new Promise(r => setTimeout(r, action.ms ?? 1000))
          return { ok: true }
        case "scroll": {
          await relay.sendCdp("Runtime.evaluate", {
            expression: `window.scrollBy(0, ${action.y ?? 600})`,
          })
          return { ok: true }
        }
        case "click": {
          if (action.elementRef) {
            const ref = action.elementRef
            const byRef = await this.evalString(
              relay,
              `(() => {
                const el = document.querySelector('[data-ref=${JSON.stringify(ref)}]');
                if (!el) return 'not-found';
                el.scrollIntoView({ block: 'center' });
                el.click();
                return 'ok';
              })()`,
            )
            if (byRef === "ok") return { ok: true, resolvedVia: "ref" }
            // Ref gone (SPA re-render) — re-resolve by role+name.
            const meta = this.lastRefs.get(ref)
            if (meta?.name) {
              const byName = await this.evalString(
                relay,
                `(() => {
                  const cands = document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], input[type="submit"], input[type="button"], [onclick]');
                  const want = ${JSON.stringify(meta.name)}.toLowerCase();
                  for (const el of cands) {
                    const t = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
                    if (t && t.toLowerCase().includes(want)) {
                      el.scrollIntoView({ block: 'center' });
                      el.click();
                      el.setAttribute('data-ref', ${JSON.stringify(ref)});
                      return 'ok';
                    }
                  }
                  return 'not-found';
                })()`,
              )
              if (byName === "ok") return { ok: true, resolvedVia: "fallback" }
            }
            return {
              ok: false,
              error: `Element ${ref} not found — the page likely changed. Call browser_observe for a fresh snapshot.`,
            }
          }
          // Coordinate click (vision mode) — dispatch a real mouse event.
          if (action.x != null && action.y != null) {
            await relay.sendCdp("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: action.x,
              y: action.y,
              button: "left",
              clickCount: 1,
            })
            await relay.sendCdp("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: action.x,
              y: action.y,
              button: "left",
              clickCount: 1,
            })
            return { ok: true }
          }
          return { ok: false, error: "click needs elementRef or x/y" }
        }
        case "type": {
          if (!action.elementRef)
            return { ok: false, error: "type needs elementRef" }
          const ref = action.elementRef
          // Focus + select existing content (so insertText replaces rather
          // than appends), then type via real CDP text insertion — works for
          // React inputs AND contenteditable, and fires native input events.
          const focused = await this.evalString(
            relay,
            `(() => {
              const el = document.querySelector('[data-ref=${JSON.stringify(ref)}]') ||
                (() => {
                  // ref may be stale — same role+name fallback as click
                  const meta = ${JSON.stringify(this.lastRefs.get(ref) ?? null)};
                  if (!meta || !meta.name) return null;
                  const want = meta.name.toLowerCase();
                  for (const c of document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable="true"]')) {
                    const t = (c.getAttribute('aria-label') || c.getAttribute('placeholder') || c.labels && c.labels[0] && c.labels[0].innerText || '').replace(/\\s+/g, ' ').trim();
                    if (t && t.toLowerCase().includes(want)) { c.setAttribute('data-ref', ${JSON.stringify(ref)}); return c; }
                  }
                  return null;
                })();
              if (!el) return 'not-found';
              el.focus();
              if (typeof el.select === 'function') el.select();
              else if (el.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              }
              return 'ok';
            })()`,
          )
          if (focused !== "ok") {
            return {
              ok: false,
              error: `Element ${ref} not found — call browser_observe for a fresh snapshot.`,
            }
          }
          try {
            await relay.sendCdp("Input.insertText", { text: action.text ?? "" })
            return { ok: true }
          } catch {
            // Input.insertText unavailable on this target — best-effort
            // fallback: set value + dispatch synthetic input/change (React
            // honours these; plain contenteditable does not).
            await relay.sendCdp("Runtime.evaluate", {
              expression: `(() => {
                const el = document.querySelector('[data-ref=${JSON.stringify(ref)}]');
                if (!el) return 'not-found';
                el.value = ${JSON.stringify(action.text ?? "")};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'ok';
              })()`,
              returnByValue: true,
            })
            return { ok: true }
          }
        }
        case "press": {
          // Real key events via CDP — synthetic KeyboardEvents don't trigger
          // browser defaults (Enter wouldn't submit a form, Tab wouldn't
          // move focus).
          const key = action.key ?? "Enter"
          const mapped = mapKey(key)
          await relay.sendCdp("Input.dispatchKeyEvent", {
            type: mapped.text ? "keyDown" : "rawKeyDown",
            key: mapped.key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.keyCode,
            ...(mapped.text ? { text: mapped.text } : {}),
          })
          await relay.sendCdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: mapped.key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.keyCode,
          })
          return { ok: true }
        }
        default:
          return { ok: false, error: `unknown action: ${action.action}` }
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * Extract structured data from the current page via a free-form prompt.
   * Runs an LLM call over the page's snapshot tree + main-region text and
   * returns the model's answer. This is how the agent pulls job details
   * (title, company, requirements) off a posting it navigated to.
   */
  @callable()
  async extract(opts: {
    goal: string
    runId?: string
  }): Promise<{ answer: string; __trace?: any }> {
    const relay = await this.relay()
    const page = (await this.observe()).page
    if (!page) return { answer: "(no page to extract from)" }
    // Main-region text complements the tree: structure from the snapshot,
    // content from the region read (each independently capped).
    const main = await this.read()

    const runId = opts.runId ?? "browser-extract-standalone"
    const recorder = new TraceRecorder({
      agent: "browser-agent",
      runId,
      redactKeys: [],
    })
    recorder.recordSystem("system-prompt", "You extract data from web pages for a job-search agent.")
    recorder.recordPrompt(0, [{ role: "user", content: buildExtractPrompt(opts.goal, page, main.text) }])

    const model = getModel(this.env)
    const result = await generateText({
      model,
      system:
        "You extract structured data from web pages. Return ONLY the requested data, concisely. Never fabricate — if the page lacks it, say so.",
      prompt: buildExtractPrompt(opts.goal, page, main.text),
      ...getParams(this.env),
      ...recorder.attach(),
    })
    recorder.flushFallback(null, Date.now(), {
      usage: result.usage,
      steps: result.steps,
      response: result.response,
      finishReason: result.finishReason,
      warnings: result.warnings,
    })
    return { answer: result.text, __trace: recorder.toSubAgentTrace() }
  }

  /**
   * Run an autonomous extraction session: navigate, observe, extract — with a
   * small multi-step loop so the agent can click through a results page to a
   * posting before extracting. Used by the discover_jobs path when a source
   * needs the browser.
   */
  @callable()
  async browseAndExtract(opts: {
    url: string
    goal: string
    runId?: string
    maxSteps?: number
  }): Promise<{ answer: string; ok: boolean; error?: string; __trace?: any }> {
    const runId = opts.runId ?? "browser-browse-standalone"
    const recorder = new TraceRecorder({
      agent: "browser-agent",
      runId,
      redactKeys: [],
    })
    recorder.recordSubAgentStart(`browse+extract: ${opts.url}`, opts.maxSteps ?? 6, 0)

    const nav = await this.navigate(opts.url)
    if (!nav.ok) {
      return { answer: "", ok: false, error: nav.error }
    }
    const obs = await this.observe()
    if (obs.loginRequired) {
      return { answer: "", ok: false, error: obs.prompt }
    }
    const ex = await this.extract({ goal: opts.goal, runId })
    return { answer: ex.answer, ok: true, __trace: ex.__trace }
  }

  /**
   * Manual test harness — used by the dashboard's Browser Test panel. Runs a
   * navigate + observe against the connected browser and returns the raw
   * result (target state, page title/url, tree node count, login-wall flag,
   * any error). This is the fastest way to verify the whole chain (relay →
   * extension → Chrome → CDP) without running a full agent loop. No LLM call,
   * so it's free to run repeatedly.
   */
  @callable()
  async probe(url: string): Promise<{
    target: string
    navigated: boolean
    url: string
    title: string
    elementCount: number
    loginRequired: boolean
    bodyPreview: string
    truncated: boolean
    error?: string
  }> {
    const relay: any = await this.relay()
    const target = (await relay.targetKind?.()) ?? "none"
    if (target === "none") {
      return {
        target: "none",
        navigated: false,
        url,
        title: "",
        elementCount: 0,
        loginRequired: false,
        bodyPreview: "",
        truncated: false,
        error:
          "No browser target connected. Connect the extension (Settings → Browser) and retry.",
      }
    }
    const nav = await this.navigate(url)
    if (!nav.ok) {
      return {
        target,
        navigated: false,
        url,
        title: "",
        elementCount: 0,
        loginRequired: false,
        bodyPreview: "",
        truncated: false,
        error: nav.error,
      }
    }
    const obs = await this.observe()
    if (obs.loginRequired) {
      return {
        target,
        navigated: true,
        url,
        title: obs.page?.title ?? nav.title,
        elementCount: 0,
        loginRequired: true,
        bodyPreview: "",
        truncated: false,
        error: obs.prompt,
      }
    }
    const page = obs.page
    const main = await this.read()
    return {
      target,
      navigated: true,
      url: page?.url ?? url,
      title: page?.title ?? nav.title,
      elementCount: (page?.tree.match(/\[ref=/g) ?? []).length,
      loginRequired: false,
      bodyPreview: (page?.tree ?? "").slice(0, 500),
      truncated: !!page?.truncated,
      error: main.error,
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Map a key name to CDP Input.dispatchKeyEvent fields. */
function mapKey(key: string): {
  key: string
  code: string
  keyCode: number
  text?: string
} {
  const named: Record<string, { code: string; keyCode: number }> = {
    enter: { code: "Enter", keyCode: 13 },
    tab: { code: "Tab", keyCode: 9 },
    escape: { code: "Escape", keyCode: 27 },
    esc: { code: "Escape", keyCode: 27 },
    backspace: { code: "Backspace", keyCode: 8 },
    delete: { code: "Delete", keyCode: 46 },
    insert: { code: "Insert", keyCode: 45 },
    home: { code: "Home", keyCode: 36 },
    end: { code: "End", keyCode: 35 },
    pageup: { code: "PageUp", keyCode: 33 },
    pagedown: { code: "PageDown", keyCode: 34 },
    arrowleft: { code: "ArrowLeft", keyCode: 37 },
    arrowright: { code: "ArrowRight", keyCode: 39 },
    arrowup: { code: "ArrowUp", keyCode: 38 },
    arrowdown: { code: "ArrowDown", keyCode: 40 },
    " ": { code: "Space", keyCode: 32 },
  }
  const lower = key.toLowerCase()
  if (named[lower]) {
    const isPrintable = lower === " "
    return {
      key: lower === " " ? " " : key.length === 1 ? key : normalizeKeyName(key),
      code: named[lower].code,
      keyCode: named[lower].keyCode,
      ...(isPrintable ? { text: " " } : {}),
    }
  }
  if (/^[a-z]$/i.test(key)) {
    return {
      key: key,
      code: "Key" + key.toUpperCase(),
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    }
  }
  if (/^[0-9]$/.test(key)) {
    return { key: key, code: "Digit" + key, keyCode: key.charCodeAt(0), text: key }
  }
  // Unknown key — pass through with keyCode 0; pages reading key/code still work.
  return { key, code: "", keyCode: 0, ...(key.length === 1 ? { text: key } : {}) }
}

function normalizeKeyName(key: string): string {
  const map: Record<string, string> = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
  }
  return map[key.toLowerCase()] ?? key
}

function buildExtractPrompt(
  goal: string,
  page: PageSnapshot,
  mainText: string,
): string {
  return (
    `PAGE: ${page.title}\nURL: ${page.url}\n\n` +
    `GOAL: ${goal}\n\n` +
    `PAGE STRUCTURE (accessibility tree, may be truncated):\n${page.tree.slice(0, SNAPSHOT_MAX_CHARS)}\n\n` +
    `MAIN TEXT (may be truncated):\n${mainText}\n\n` +
    `Return only the data the goal asks for. If the page does not contain it, say "not found on this page".`
  )
}

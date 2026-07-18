// =============================================================================
// BrowserAgent — drives a browser (via the relay) to read login-walled pages.
// =============================================================================
// The harness calls browser_navigate / browser_observe / browser_act /
// browser_extract (delegation tools in src/tools/browser.tool.ts); those RPC
// into THIS agent. This agent speaks CDP to the BrowserRelay, which routes to
// the user's real logged-in Chrome (live) or the managed headless Chromium.
//
// TEXT-ONLY MODEL SUPPORT
// The configured model is text-only. So observe() returns the page as a
// STRUCTURED element list (accessibility-ish tree with stable elementIds),
// not a screenshot. act() takes semantic actions keyed by elementId. A
// vision flag (llm-config.json → browser.vision) optionally adds screenshots
// + coordinate clicks — but the default path needs no vision.
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
import { generateText, tool, isStepCount } from "ai"
import { z } from "zod"
import { getModel, getParams } from "../llm"
import type { Env } from "../types"
import { TraceRecorder } from "../utils/trace-recorder"
import browserConfig from "../config/browser-config.json"
import llmConfig from "../config/llm-config.json"
import { getAgentByName } from "agents"

// -----------------------------------------------------------------------------
// Login-wall detection (see browser-config.json → safety)
// -----------------------------------------------------------------------------
const SAFETY = (browserConfig as any).safety ?? {}
const LOGIN_PATTERNS: string[] = SAFETY.loginWallUrlPatterns ?? []
const LOGIN_SELECTORS: string[] = SAFETY.loginWallInputSelectors ?? []

interface PageSnapshot {
  url: string
  title: string
  /** Elements the model can act on: { elementId, role, name, tag, text } */
  elements: Array<{
    elementId: string
    role: string
    name: string
    tag: string
    text: string
  }>
  /** Body text, truncated for the model context. */
  bodyText: string
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
      // Best-effort wait for load — give the page a moment to settle.
      const navTimeout = (browserConfig as any).managed?.navigationTimeoutMs ?? 30000
      await new Promise(r => setTimeout(r, Math.min(2500, navTimeout)))
      const titleEval: any = await relay.sendCdp("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })
      const title = titleEval?.result?.value ?? ""
      return { url, title, ok: true }
    } catch (e: any) {
      return { url, title: "", ok: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * Observe the current page: return a structured element list (text-only) +
   * body text. Detects login walls and STOPS — never attempts login.
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

      // Build the element list + body text for the model.
      const page = await this.snapshotPage(relay, meta.url, meta.title)
      return { page }
    } catch (e: any) {
      return { prompt: `observe failed: ${e?.message ?? String(e)}` }
    }
  }

  /**
   * Snapshot the page into a PageSnapshot: interactive elements (links,
   * buttons, inputs, etc.) with stable elementIds, plus truncated body text.
   * The elementIds are generated per-snapshot and stable only within it —
   * the model must re-observe after any act() that may change the DOM.
   */
  private async snapshotPage(
    relay: any,
    url: string,
    title: string,
  ): Promise<PageSnapshot> {
    const vision = !!((llmConfig as any).browser?.vision ?? false)
    // One eval to extract elements + body text + (optionally) a screenshot
    // via the canvas-toDataURL trick (managed) — kept simple here.
    const evalRes: any = await relay.sendCdp("Runtime.evaluate", {
      expression: `(() => {
        const interactive = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [onclick]';
        const els = Array.from(document.querySelectorAll(interactive));
        const out = [];
        let id = 0;
        for (const el of els) {
          if (out.length >= 60) break;
          const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 80);
          if (!name) continue;
          out.push({
            elementId: 'el-' + (id++),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            name,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 120)
          });
          // Tag the element in the DOM so a later act() can find it by id.
          el.setAttribute('data-ob-id', 'el-' + (id - 1));
        }
        const bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 6000);
        return JSON.stringify({ elements: out, bodyText });
      })()`,
      returnByValue: true,
    })
    const parsed = JSON.parse(evalRes?.result?.value ?? "{}")
    const snap: PageSnapshot = {
      url,
      title,
      elements: parsed.elements ?? [],
      bodyText: parsed.bodyText ?? "",
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
   * Act on the page: click an element, type into it, scroll, or press a key.
   * elementId-based actions resolve via the data-ob-id attribute observe()
   * stamped; coordinate clicks only when vision mode is on.
   */
  @callable()
  async act(action: {
    action: "click" | "type" | "scroll" | "press" | "wait"
    elementId?: string
    text?: string
    key?: string
    x?: number
    y?: number
    ms?: number
  }): Promise<{ ok: boolean; error?: string }> {
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
          if (action.elementId) {
            await relay.sendCdp("Runtime.evaluate", {
              expression: `(() => { const el = document.querySelector('[data-ob-id=${JSON.stringify(action.elementId)}]'); if (el) { el.click(); return 'ok'; } return 'not-found'; })()`,
              returnByValue: true,
            })
            return { ok: true }
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
          return { ok: false, error: "click needs elementId or x/y" }
        }
        case "type": {
          if (!action.elementId)
            return { ok: false, error: "type needs elementId" }
          // Focus then set value + dispatch input event so SPA frameworks react.
          await relay.sendCdp("Runtime.evaluate", {
            expression: `(() => {
              const el = document.querySelector('[data-ob-id=${JSON.stringify(action.elementId)}]');
              if (!el) return 'not-found';
              el.focus();
              el.value = ${JSON.stringify(action.text ?? "")};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'ok';
            })()`,
            returnByValue: true,
          })
          return { ok: true }
        }
        case "press": {
          // Best-effort key press via a synthetic KeyboardEvent.
          await relay.sendCdp("Runtime.evaluate", {
            expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(action.key ?? "Enter")} })); document.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(action.key ?? "Enter")} }))`,
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
   * Runs an LLM call over the page's bodyText + element list and returns the
   * model's answer. This is how the agent pulls job details (title, company,
   * requirements) off a posting it navigated to.
   */
  @callable()
  async extract(opts: {
    goal: string
    runId?: string
  }): Promise<{ answer: string; __trace?: any }> {
    const relay = await this.relay()
    const page = (await this.observe()).page
    if (!page) return { answer: "(no page to extract from)" }

    const runId = opts.runId ?? "browser-extract-standalone"
    const recorder = new TraceRecorder({
      agent: "browser-agent",
      runId,
      redactKeys: [],
    })
    recorder.recordSystem("system-prompt", "You extract data from web pages for a job-search agent.")
    recorder.recordPrompt(0, [{ role: "user", content: buildExtractPrompt(opts.goal, page) }])

    const model = getModel(this.env)
    const result = await generateText({
      model,
      system:
        "You extract structured data from web pages. Return ONLY the requested data, concisely. Never fabricate — if the page lacks it, say so.",
      prompt: buildExtractPrompt(opts.goal, page),
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
    recorder.recordRunStart(`browse+extract: ${opts.url}`, opts.maxSteps ?? 6, 0)

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
   * result (target state, page title/url, element count, login-wall flag, any
   * error). This is the fastest way to verify the whole chain (relay →
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
        elementCount: obs.page?.elements.length ?? 0,
        loginRequired: true,
        bodyPreview: "",
        error: obs.prompt,
      }
    }
    const page = obs.page
    return {
      target,
      navigated: true,
      url: page?.url ?? url,
      title: page?.title ?? nav.title,
      elementCount: page?.elements.length ?? 0,
      loginRequired: false,
      bodyPreview: (page?.bodyText ?? "").slice(0, 500),
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildExtractPrompt(goal: string, page: PageSnapshot): string {
  const els = page.elements
    .slice(0, 40)
    .map(e => `- ${e.elementId} [${e.role}] ${e.name}`)
    .join("\n")
  return (
    `PAGE: ${page.title}\nURL: ${page.url}\n\n` +
    `GOAL: ${goal}\n\n` +
    `ELEMENTS:\n${els}\n\n` +
    `BODY TEXT (truncated):\n${page.bodyText}\n\n` +
    `Return only the data the goal asks for. If the page does not contain it, say "not found on this page".`
  )
}

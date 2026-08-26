// =============================================================================
// Browser tools — delegation to the BrowserAgent DO (which drives the relay).
// =============================================================================
//  browser_navigate  → open a URL in the connected browser
//  browser_observe   → compact accessibility-tree snapshot (roles + names +
//                      refs like [ref=e5]); detects login walls and stops
//  browser_read      → lazy text read: a specific ref's node, or the main
//                      content region (the token-saving companion to observe)
//  browser_act       → click / type / scroll / press on the page
//  browser_extract   → pull structured data off the current page via an LLM
//  browser_browse    → navigate + observe + extract in one call (the common
//                      path for reading a login-walled posting)
//
// TOKEN STRATEGY: observe() returns structure only (the tree), NOT full page
// text — the model pulls content it needs via browser_read. This keeps each
// observe cheap and avoids re-shipping body text the model already read.
//
// The agent NEVER handles credentials. observe() returns loginRequired when a
// page needs auth, and the caller surfaces that to the operator.
// =============================================================================
import { tool } from "ai"
import { z } from "zod"
import { getAgentByName } from "agents"
import type { Env } from "../types"
import type { BrowserAgent } from "../agents"
import { withRpcRetry } from "../utils/rpc-retry"
import { httpUrlSchema } from "../utils/validation"
import type { RunIdRef } from "./jobs.tool"

type Advance = (toolName: string, input: string | null) => void

// Resolve THIS user's BrowserAgent. The userId is the multi-tenant key — it
// drives the agent, which in turn resolves the user's own BrowserRelay (their
// live Chrome connection).
const BROWSER_AGENT = (env: Env, userId: string) =>
  getAgentByName<Env, BrowserAgent>(env.BROWSER_AGENT, userId)

export function makeBrowserNavigateTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Open a URL in the connected browser (the operator's real, logged-in Chrome via the extension, or the managed headless browser). " +
      "Use this for login-walled job sites (Indeed, LinkedIn, Glassdoor) that fetch_page cannot read. " +
      "Requires a browser target to be connected — check browser_status first. The agent never logs in; the operator must be signed in already.",
    inputSchema: z.object({
      // AUDIT M4: z.string().url() alone accepts javascript:/data:/file: —
      // this refinement confines navigation to http(s). These tools drive the
      // user's REAL Chrome, so a prompt-injected model must not be able to
      // execute script:// URLs or open non-web schemes.
      url: httpUrlSchema("url").describe("Absolute http(s) URL to navigate to"),
    }),
    execute: async ({ url }) => {
      advance("browser_navigate", JSON.stringify({ url }).slice(0, 2000))
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() => agent.navigate(url))
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserObserveTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Read the current browser page as a compact accessibility tree: role-named nodes with refs, e.g. `- link \"Apply now\" [ref=e5]`, `- heading \"Requirements\" [level=2]`, plus short text lines. " +
      "The tree shows STRUCTURE, not full page content — call browser_read when you need the actual text of a region or element. " +
      "Returns loginRequired if the page needs sign-in — in that case, STOP and tell the operator to log in; never attempt login. " +
      "Works with text-only models (no screenshot needed). Always re-observe after an action that changes the page — refs go stale.",
    inputSchema: z.object({}),
    execute: async () => {
      advance("browser_observe", null)
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() => agent.observe())
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserReadTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Read page TEXT lazily (observe() only returns the structure tree). Without elementRef: the main content region's text. With an elementRef from the last observe (e.g. 'e5'): that element's text. " +
      "Use this AFTER observe to pull only the content you actually need — cheaper than re-observing. Returns { text, truncated }.",
    inputSchema: z.object({
      elementRef: z
        .string()
        .optional()
        .describe("ref from the last browser_observe, e.g. 'e5'. Omit to read the main content region."),
    }),
    execute: async ({ elementRef }) => {
      advance("browser_read", JSON.stringify({ elementRef }).slice(0, 2000))
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() => agent.read(elementRef))
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserActTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Act on the browser page: click an element (by elementRef from observe, e.g. 'e5'), type into an input, scroll, press a key (real key events — Enter submits forms), or wait. " +
      "elementRef-based actions are preferred (work with text-only models). Coordinate clicks (x/y) only work in vision mode. " +
      "File uploads/attachments are NOT supported — there is no file-picker action. Never claim to have uploaded or attached a document (CV, cover letter, portfolio); " +
      "leave file-upload fields for the operator and flag them in your finish summary.",
    inputSchema: z.object({
      action: z.enum(["click", "type", "scroll", "press", "wait"]),
      elementRef: z
        .string()
        .optional()
        .describe("element ref from the last observe() — e.g. 'e5'"),
      text: z.string().optional().describe("text to type (for 'type')"),
      key: z.string().optional().describe("key to press (for 'press'), e.g. 'Enter'"),
      x: z.number().optional().describe("x coordinate (vision mode click)"),
      y: z.number().optional().describe("y coordinate (vision mode click)"),
      ms: z.number().optional().describe("milliseconds to wait (for 'wait')"),
    }),
    execute: async args => {
      advance("browser_act", JSON.stringify(args).slice(0, 2000))
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() => agent.act(args))
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserExtractTool(
  env: Env,
  advance: Advance,
  runIdRef: RunIdRef,
  userId: string,
) {
  return tool({
    description:
      "Extract structured data from the current browser page (e.g. a job posting's title, company, requirements) using an LLM over the page text. " +
      "Navigate + observe first so the page is loaded. Returns the extracted data as text.",
    inputSchema: z.object({
      goal: z
        .string()
        .describe("What to extract, e.g. 'the job title, company, location, and key requirements'"),
    }),
    execute: async ({ goal }) => {
      advance("browser_extract", JSON.stringify({ goal }).slice(0, 2000))
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() =>
        agent.extract({ goal, runId: runIdRef.value }),
      )
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserBrowseTool(
  env: Env,
  advance: Advance,
  runIdRef: RunIdRef,
  userId: string,
) {
  return tool({
    description:
      "One-shot browse + extract: navigate to a URL, observe the page, and extract structured data per the goal. " +
      "This is the common path for reading a login-walled job posting end-to-end. " +
      "Returns the extracted data, or loginRequired if the page needs sign-in.",
    inputSchema: z.object({
      // AUDIT M4: http(s) only — see makeBrowserNavigateTool.
      url: httpUrlSchema("url"),
      goal: z.string().describe("what to extract from the page"),
    }),
    execute: async ({ url, goal }) => {
      advance("browser_browse", JSON.stringify({ url, goal }).slice(0, 2000))
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() =>
        agent.browseAndExtract({ url, goal, runId: runIdRef.value }),
      )
      return JSON.stringify(result)
    },
  })
}

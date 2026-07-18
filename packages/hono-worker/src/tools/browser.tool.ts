// =============================================================================
// Browser tools — delegation to the BrowserAgent DO (which drives the relay).
// =============================================================================
//  browser_navigate  → open a URL in the connected browser
//  browser_observe   → structured snapshot of the page (elements + text);
//                      detects login walls and stops
//  browser_act       → click / type / scroll / press on the page
//  browser_extract   → pull structured data off the current page via an LLM
//  browser_browse    → navigate + observe + extract in one call (the common
//                      path for reading a login-walled posting)
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
      url: z.string().url().describe("Absolute URL to navigate to"),
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
      "Read the current browser page as a structured element list (clickable elements with stable ids) + body text. " +
      "Returns loginRequired if the page needs sign-in — in that case, STOP and tell the operator to log in; never attempt login. " +
      "Works with text-only models (no screenshot needed). Always re-observe after an action that changes the page.",
    inputSchema: z.object({}),
    execute: async () => {
      advance("browser_observe", null)
      const agent = await BROWSER_AGENT(env, userId)
      const result = await withRpcRetry(() => agent.observe())
      return JSON.stringify(result)
    },
  })
}

export function makeBrowserActTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Act on the browser page: click an element (by elementId from observe), type into an input, scroll, press a key, or wait. " +
      "elementId-based actions are preferred (work with text-only models). Coordinate clicks (x/y) only work in vision mode.",
    inputSchema: z.object({
      action: z.enum(["click", "type", "scroll", "press", "wait"]),
      elementId: z
        .string()
        .optional()
        .describe("element id from the last observe() — e.g. 'el-3'"),
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
      url: z.string().url(),
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

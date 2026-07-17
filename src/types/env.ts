// =============================================================================
// Cloudflare Worker environment bindings
// =============================================================================
// Type-only imports keep the namespace generics strongly typed without a
// runtime circular dependency (the agent files import types from here).
import type {
  Harness,
  ResearchAgent,
  JobApplicationAgent,
} from "../agents"
import type { BrowserAgent, BrowserRelay } from "../agents/browser-relay"

/**
 * Cloudflare Worker environment bindings.
 * Populated from wrangler.jsonc and secrets.
 */
export interface Env {
  // Durable Object namespaces — typed with their DO class so RPC method calls
  // (e.g. `await harness.start()`) are checked by the compiler.
  HARNESS: DurableObjectNamespace<Harness>
  RESEARCH_AGENT: DurableObjectNamespace<ResearchAgent>
  JOB_AGENT: DurableObjectNamespace<JobApplicationAgent>

  // Browser capability (login-walled job sites). The relay DO bridges agent
  // CDP commands to either the user's real Chrome (via the extension relay)
  // or the managed headless Chromium (paid plan). The agent DO runs the
  // observe/act/extract LLM loop.
  BROWSER_RELAY: DurableObjectNamespace<BrowserRelay>
  BROWSER_AGENT: DurableObjectNamespace<BrowserAgent>

  // Managed headless browser binding (@cloudflare/playwright). Optional — only
  // present on the paid Workers plan. When absent, the relay targets the
  // extension (live) target only. Typed as a bare Fetcher so tsc doesn't choke
  // when the binding is missing in local dev.
  BROWSER?: Fetcher

  // Workers AI binding. Optional in v1 (the harness still calls the BYOK model
  // via the AI SDK); becomes the default for v2 when we drop the LLM_API_KEY
  // dependency and route through env.AI instead. Typed loosely so tsc doesn't
  // choke if the binding is absent during local dev.
  AI?: Ai

  // Secrets only — model identity + provider + generation params live in
  // src/config/llm-config.json (tunable, version-controlled). Env keeps the API key
  // plus runtime knobs that DON'T make sense in a static config (DO tokens).
  LLM_API_KEY: string
  MAX_STEPS: string
  DASHBOARD_TOKEN: string

  // v2 non-secret knobs (sourced from wrangler.jsonc vars). Trace capture
  // toggle — "1" = on (default); any other value = off. Detailed cap values
  // (maxReasoningChars etc.) live in src/config/observability-config.json.
  CAPTURE_TRACE?: string

  // Forward-looking sendmail (Phase 2) — kept on Env so the sendmail tool can
  // read them at runtime without a redeploy when populated.
  MAIL_FROM?: string
  MAIL_ALLOWLIST?: string
}

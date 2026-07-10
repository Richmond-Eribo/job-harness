// =============================================================================
// Cloudflare Worker environment bindings
// =============================================================================
// Type-only imports keep the namespace generics strongly typed without a
// runtime circular dependency (the agent files import types from here).
import type { Harness, ResearchAgent, JobApplicationAgent } from "../agents"

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

  // Secrets only — model identity + provider + generation params live in
  // src/llm-config.json (tunable, version-controlled). Env keeps the API key
  // plus runtime knobs that DON'T make sense in a static config (DO tokens).
  LLM_API_KEY: string
  MAX_STEPS: string
  DASHBOARD_TOKEN: string
}

// =============================================================================
// User-authored memory (distinct from the agent's own context table).
// =============================================================================
// Two memory layers exist side by side:
//   - context (Harness) → the agent's OWN remembered facts (remember/recall tools)
//   - user_memory       → human-authored notes injected into every system prompt
// User memory is editable from the dashboard and ships in the system prompt as
// a separate, higher-authority layer above the agent's recall.
// =============================================================================

export interface UserMemory {
  key: string
  value: string
  updatedAt: string
}

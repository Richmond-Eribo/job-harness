// =============================================================================
// Barrel for agent Durable Object classes consumed by the Worker entry.
// =============================================================================
export { Harness } from "./harness"
export { ResearchAgent } from "./research-agent"
export { JobApplicationAgent } from "./job-agent"
// Browser capability — reaches login-walled job sites via the user's real
// Chrome (extension relay) or the managed headless Chromium (paid plan).
export { BrowserRelay, BROWSER_RELAY_ID } from "./browser-relay"
export { BrowserAgent } from "./browser-agent"

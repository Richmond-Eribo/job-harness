// =============================================================================
// renderDashboard — renders the dashboard through Hono's jsxRenderer.
// =============================================================================
// Lives in a .tsx file (not .ts) because it contains JSX. index.ts (a .ts file)
// calls this so it doesn't need JSX itself.
// =============================================================================

import type { Context } from "hono"
import type { Env } from "../types"
import Dashboard from "./Dashboard"

export function renderDashboard(c: Context<{ Bindings: Env }>) {
  // jsxRenderer middleware is registered in index.ts, so c.render() is available
  // here. The renderer wraps <Dashboard/> in <Layout>.
  return c.render(<Dashboard />)
}

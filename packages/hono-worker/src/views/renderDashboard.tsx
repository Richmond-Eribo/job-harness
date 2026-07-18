// =============================================================================
// renderPage — renders a single page through the PageLayout + the HTML shell.
// =============================================================================
// Replaces the old `renderDashboard(c)` which rendered all six pages at once.
// Each Hono route now calls `renderPage(c, "overview", <OverviewPage …/>)` —
// the renderer middleware wraps the PageLayout in the shared HtmlShell.
// =============================================================================

import type { Context } from "hono"
import type { FC } from "hono/jsx"
import type { AppEnv } from "../types/app-env"
import { PageLayout } from "./Layout"

export function renderPage(
  c: Context<AppEnv>,
  activePage: string,
  Page: FC<any>,
  props: Record<string, any> = {},
) {
  return c.render(
    <PageLayout activePage={activePage}>
      <Page {...props} />
    </PageLayout>,
  )
}

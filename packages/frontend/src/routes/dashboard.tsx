import { createFileRoute } from "@tanstack/react-router"
import { OverviewPage } from "../pages/OverviewPage"
import { requireAuth } from "../lib/guards"

// `/dashboard` — app shell. The agent status overview + run controls.
export const Route = createFileRoute("/dashboard")({
  component: OverviewPage,
  beforeLoad: requireAuth,
})

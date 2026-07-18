import { createFileRoute } from "@tanstack/react-router"
import { OverviewPage } from "../pages/OverviewPage"

// `/dashboard` — app shell. The agent status overview + run controls.
export const Route = createFileRoute("/dashboard")({
  component: OverviewPage,
})

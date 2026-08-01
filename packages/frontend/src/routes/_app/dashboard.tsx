import { createFileRoute } from "@tanstack/react-router"
import { OverviewPage } from "../../pages/OverviewPage"

// `/dashboard` — app shell. The agent status overview + run controls.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/dashboard")({
  component: OverviewPage,
})

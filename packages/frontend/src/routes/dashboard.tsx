import { createFileRoute } from "@tanstack/react-router"
import { OverviewPage } from "../pages/OverviewPage"
import { requireProfile } from "../lib/guards"

// `/dashboard` — app shell. The agent status overview + run controls.
// `requireProfile` runs requireAuth + the first/last-name gate: a new signup
// (which has OTP-verified but no name yet) is bounced to /settings/profile
// before this page renders.
export const Route = createFileRoute("/dashboard")({
  component: OverviewPage,
  beforeLoad: requireProfile,
})

import { createFileRoute } from "@tanstack/react-router"
import { SettingsPage } from "../pages/SettingsPage"
import { requireAuth } from "../lib/guards"

// `/settings` — the tabbed settings surface: Profile + LLM Config tabs.
export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  beforeLoad: requireAuth,
})

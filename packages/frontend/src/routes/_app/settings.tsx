import { createFileRoute } from "@tanstack/react-router"
import { SettingsPage } from "../../pages/SettingsPage"

// `/settings` — the tabbed settings surface: Profile + LLM Config tabs.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
})

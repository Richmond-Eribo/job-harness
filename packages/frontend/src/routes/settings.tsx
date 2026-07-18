import { createFileRoute } from "@tanstack/react-router"
import { SettingsPage } from "../pages/SettingsPage"

// `/settings` — app shell. Profile editor + CV upload.
export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

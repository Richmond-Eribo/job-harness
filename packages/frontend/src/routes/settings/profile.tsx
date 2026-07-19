import { createFileRoute } from "@tanstack/react-router"
import { ProfilePage } from "../../pages/ProfilePage"
import { requireAuth } from "../../lib/guards"

// `/settings/profile` — the profile editor. Uses requireAuth (any signed-in
// user can edit their own profile). firstName/lastName are collected at signup
// now, so there's no gate that redirects here — it's just the editor.
export const Route = createFileRoute("/settings/profile")({
  component: ProfilePage,
  beforeLoad: requireAuth,
})

import { createFileRoute, redirect } from "@tanstack/react-router"

// `/settings` — redirects to the profile sub-page. The settings surface is
// currently just the profile editor at /settings/profile; this redirect keeps
// the old link working (sidebar, bookmarks, the "Settings" nav item).
export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/profile", replace: true })
  },
})

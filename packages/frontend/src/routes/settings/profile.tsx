import { createFileRoute, redirect } from "@tanstack/react-router"

// `/settings/profile` — legacy deep link. The profile editor now lives as the
// default tab of /settings, so we redirect old bookmarks/sidebar links there.
export const Route = createFileRoute("/settings/profile")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", replace: true })
  },
})

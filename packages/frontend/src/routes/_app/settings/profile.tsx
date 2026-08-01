import { createFileRoute, redirect } from "@tanstack/react-router"

// `/settings/profile` — legacy deep link. The profile editor now lives as the
// default tab of /settings, so we redirect old bookmarks/sidebar links there.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/settings/profile")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", replace: true })
  },
})

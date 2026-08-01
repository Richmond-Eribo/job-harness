import { createFileRoute, Outlet } from "@tanstack/react-router"

// `/traces` — app-shell layout route. Gives `/traces/` and `/traces/$runId`
// a shared parent with a single `requireAuth` guard (inherited from
// `routes/_app.tsx`) so each child no longer has to repeat it. Children live
// in `traces/index.tsx` and `traces/$runId.tsx`.
export const Route = createFileRoute("/_app/traces")({
  component: () => <Outlet />,
})

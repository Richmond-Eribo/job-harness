import { createFileRoute, Outlet } from "@tanstack/react-router"
import { requireAuth } from "../lib/guards"

// `/traces` — app-shell layout route. Gives `/traces/` and `/traces/$runId`
// a shared parent with a single `requireAuth` guard so each child no longer
// has to repeat it. Children live in `traces/index.tsx` and `traces/$runId.tsx`.
export const Route = createFileRoute("/traces")({
  beforeLoad: requireAuth,
  component: () => <Outlet />,
})

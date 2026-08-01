import { createFileRoute } from "@tanstack/react-router"
import { JobsPage } from "../../pages/JobsPage"

// `/jobs` — app shell. Pipeline kanban + job management.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/jobs")({
  component: JobsPage,
})

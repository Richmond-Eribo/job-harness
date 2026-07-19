import { createFileRoute } from "@tanstack/react-router"
import { JobsPage } from "../pages/JobsPage"
import { requireProfile } from "../lib/guards"

// `/jobs` — app shell. Pipeline kanban + job management.
export const Route = createFileRoute("/jobs")({
  component: JobsPage,
  beforeLoad: requireProfile,
})

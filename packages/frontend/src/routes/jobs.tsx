import { createFileRoute } from "@tanstack/react-router"
import { JobsPage } from "../pages/JobsPage"

// `/jobs` — app shell. Pipeline kanban + job management.
export const Route = createFileRoute("/jobs")({
  component: JobsPage,
})

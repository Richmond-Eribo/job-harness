import { createFileRoute } from "@tanstack/react-router"
import { LogsPage } from "../pages/LogsPage"
import { requireAuth } from "../lib/guards"

// `/logs` — app shell. Step-log timeline.
export const Route = createFileRoute("/logs")({
  component: LogsPage,
  beforeLoad: requireAuth,
})

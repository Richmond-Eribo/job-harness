import { createFileRoute } from "@tanstack/react-router"
import { LogsPage } from "../pages/LogsPage"

// `/logs` — app shell. Step-log timeline.
export const Route = createFileRoute("/logs")({
  component: LogsPage,
})

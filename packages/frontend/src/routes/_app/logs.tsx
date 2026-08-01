import { createFileRoute } from "@tanstack/react-router"
import { LogsPage } from "../../pages/LogsPage"

// `/logs` — app shell. Step-log timeline.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/logs")({
  component: LogsPage,
})

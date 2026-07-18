import { createFileRoute } from "@tanstack/react-router"
import { TracesPage } from "../../pages/TracesPage"

// `/traces` — app shell. Run list.
export const Route = createFileRoute("/traces/")({
  component: TracesPage,
})

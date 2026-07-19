import { createFileRoute } from "@tanstack/react-router"
import { TracesPage } from "../../pages/TracesPage"
import { requireProfile } from "../../lib/guards"

// `/traces` — app shell. Run list.
export const Route = createFileRoute("/traces/")({
  component: TracesPage,
  beforeLoad: requireProfile,
})

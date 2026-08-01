import { createFileRoute } from "@tanstack/react-router"
import { TracesPage } from "../../../pages/TracesPage"

// `/traces/` — run list. The `requireAuth` guard is provided by the parent
// layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/traces/")({
  component: TracesPage,
})

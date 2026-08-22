import { createFileRoute } from "@tanstack/react-router"
import { JobsPage } from "../../../pages/JobsPage"

// `/jobs` — app shell. Pipeline kanban + job management.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
//
// URL search params keep board filters shareable + deep-linkable:
//   ?q=react        → card search (title/company)
//   ?status=draft   → column highlight (Overview stat cards link here)
export const Route = createFileRoute("/_app/jobs/")({
  validateSearch: (search: Record<string, unknown>): {
    q?: string
    status?: string
  } => ({
    q: typeof search.q === "string" ? search.q : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  component: JobsPage,
})

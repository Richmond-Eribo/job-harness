import { createFileRoute } from "@tanstack/react-router"
import { TraceDetailPage } from "../../../pages/TraceDetailPage"

// `/traces/$runId` — live transcript for a single run. The $runId param is
// read via useParams({ from: "/traces/$runId" }) in the page. requireAuth is
// provided by the parent layout route at `routes/_app.tsx`.
//
// `?filter=` is URL state managed by nuqs at runtime
// (src/hooks/use-tab-param.ts); this validateSearch only types the param for
// <Link search={…}> deep links.
export const Route = createFileRoute("/_app/traces/$runId")({
  validateSearch: (search: Record<string, unknown>): { filter?: string } => ({
    filter: typeof search.filter === "string" ? search.filter : undefined,
  }),
  component: TraceDetailPage,
})

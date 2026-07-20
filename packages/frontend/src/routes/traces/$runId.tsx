import { createFileRoute } from "@tanstack/react-router"
import { TraceDetailPage } from "../../pages/TraceDetailPage"

// `/traces/$runId` — live transcript for a single run. The $runId param is
// read via useParams({ from: "/traces/$runId" }) in the page. requireAuth is
// provided by the parent layout route at `routes/traces.tsx`.
export const Route = createFileRoute("/traces/$runId")({
  component: TraceDetailPage,
})

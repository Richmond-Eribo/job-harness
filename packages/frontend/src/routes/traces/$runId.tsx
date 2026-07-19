import { createFileRoute } from "@tanstack/react-router"
import { TraceDetailPage } from "../../pages/TraceDetailPage"
import { requireProfile } from "../../lib/guards"

// `/traces/$runId` — app shell. Live transcript for a single run. The
// $runId param is read via useParams({ from: "/traces/$runId" }) in the page.
export const Route = createFileRoute("/traces/$runId")({
  component: TraceDetailPage,
  beforeLoad: requireProfile,
})

import { createFileRoute } from "@tanstack/react-router"
import { TraceDetailPage } from "../../pages/TraceDetailPage"

// `/traces/$runId` — app shell. Live transcript for a single run. The
// $runId param is read via useParams({ from: "/traces/$runId" }) in the page.
export const Route = createFileRoute("/traces/$runId")({
  component: TraceDetailPage,
})

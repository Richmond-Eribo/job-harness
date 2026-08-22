import { createFileRoute, notFound } from "@tanstack/react-router"
import { JobDetailPage } from "../../pages/JobDetailPage"

// `/jobs/$jobId` — the job detail view: description + notes editing, versioned
// cover letters and tailored CVs (generate / regenerate / print), follow-ups,
// apply link + agent-assisted apply run. Reached by clicking a kanban card.
export const Route = createFileRoute("/_app/jobs/$jobId")({
  parseParams: params => {
    const jobId = Number(params.jobId)
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw notFound()
    }
    return { jobId }
  },
  component: JobDetailPage,
})

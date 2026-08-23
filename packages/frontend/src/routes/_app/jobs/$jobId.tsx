import { createFileRoute, notFound } from "@tanstack/react-router"
import { JobDetailPage } from "../../../pages/JobDetailPage"

// `/jobs/$jobId` — the job detail view: description + notes editing, versioned
// cover letters and tailored CVs (generate / regenerate / print), follow-ups,
// apply link + agent-assisted apply run. Reached by clicking a kanban card.
//
// `?tab=` is URL state managed by nuqs at runtime (src/hooks/use-tab-param.ts);
// this validateSearch only types the param for <Link search={…}> deep links.
export const Route = createFileRoute("/_app/jobs/$jobId")({
  parseParams: params => {
    const jobId = Number(params.jobId)
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw notFound()
    }
    return { jobId }
  },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  component: JobDetailPage,
})

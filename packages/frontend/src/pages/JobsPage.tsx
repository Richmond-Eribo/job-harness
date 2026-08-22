import { useCallback, useMemo, useState } from "react"
import {
  ArrowRight,
  CircleAlert,
  ExternalLink,
  Inbox,
  Search,
  Plus,
  Globe,
  Trash2,
} from "lucide-react"
import {
  usePipeline,
  useSetJobStatus,
  useAddJob,
  useJobSources,
  useAddJobSource,
  useDeleteJobSource,
  useUpdateJobSource,
} from "../hooks/queries"
import type { JobListing, JobStatus, JobSource } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@agent-harness/ui"
import { toast } from "sonner"

const COLUMNS: {
  id: JobStatus
  label: string
  accent: string
  dotColor: string
}[] = [
  {
    id: "discovered",
    label: "Discovered",
    accent: "border-t-muted-foreground/40",
    dotColor: "bg-muted-foreground",
  },
  {
    id: "draft",
    label: "Draft",
    accent: "border-t-primary",
    dotColor: "bg-primary",
  },
  {
    id: "applied",
    label: "Applied",
    accent: "border-t-warning",
    dotColor: "bg-warning",
  },
  {
    id: "interview",
    label: "Interview",
    accent: "border-t-violet-400",
    dotColor: "bg-violet-400",
  },
  {
    id: "offer",
    label: "Offer",
    accent: "border-t-success",
    dotColor: "bg-success",
  },
  {
    id: "rejected",
    label: "Rejected",
    accent: "border-t-destructive/60",
    dotColor: "bg-destructive",
  },
]

export function JobsPage() {
  const { data: pipeline, isLoading, isError, error, refetch } = usePipeline()
  const setJobStatus = useSetJobStatus()
  const addJob = useAddJob()
  const [searchQuery, setSearchQuery] = useState("")

  // Add-job + Sources modal visibility. Phase 4 parity port from the
  // legacy dashboard — these were the two missing affordances on JobsPage.
  const [addJobOpen, setAddJobOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)

  const listings = pipeline?.listings ?? []

  // Lowercase the query once per searchQuery change, not per job.
  const searchLower = useMemo(() => searchQuery.toLowerCase(), [searchQuery])

  // By-stage grouping is a single memoized pass over the filtered list.
  const byStage = useMemo(() => {
    const map: Record<JobStatus, JobListing[]> = {
      discovered: [],
      draft: [],
      applied: [],
      interview: [],
      offer: [],
      rejected: [],
    }
    for (const j of listings) {
      if (searchLower) {
        const title = j.title.toLowerCase()
        const company = j.company.toLowerCase()
        if (!title.includes(searchLower) && !company.includes(searchLower))
          continue
      }
      if (map[j.status]) map[j.status].push(j)
    }
    return map
  }, [listings, searchLower])

  // Stable handler — only closes over setJobStatus (stable).
  const advance = useCallback(
    (job: JobListing, status: JobStatus) =>
      setJobStatus.mutate(
        { jobId: job.id, status },
        {
          onSuccess: () => toast.success(`Moved job to ${status}`),
          onError: (e: { message?: string }) =>
            toast.error("Couldn't update job status", {
              description: e?.message,
            }),
        },
      ),
    [setJobStatus],
  )

  return (
    <div className="p-8 space-y-6 animate-fade-in flex flex-col h-full">
      {/* Header & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Jobs Kanban Pipeline
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your application stages and move positions through the
            funnel.
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <div className="relative w-64 max-w-full">
            <Search className="size-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Search title or company…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSourcesOpen(true)}
          >
            <Globe className="size-3.5 mr-1.5" />
            Sources
          </Button>
          <Button size="sm" onClick={() => setAddJobOpen(true)}>
            <Plus className="size-3.5 mr-1.5" />
            Add job
          </Button>
        </div>
      </div>

      {/* Kanban Board Columns */}
      {isError ? (
        <Card className="border-destructive/40 bg-destructive/5 flex-1">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load jobs pipeline</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as { message?: string })?.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1">
          {COLUMNS.map(col => (
            <Skeleton key={col.id} className="w-80 shrink-0 h-96 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 items-start">
          {COLUMNS.map((col, colIdx) => {
            const jobs = byStage[col.id]
            return (
              <div
                key={col.id}
                className={`w-80 shrink-0 bg-card rounded-xl border-t-2 ${col.accent} border border-border flex flex-col max-h-full animate-slide-up stagger-child`}
                style={{ "--stagger-i": colIdx } as React.CSSProperties}
              >
                {/* Column Sticky Header */}
                <div className="bg-card px-4 py-3.5 flex items-center justify-between border-b border-border rounded-t-xl shrink-0">
                  <span className="text-sm font-semibold flex items-center gap-2">
                    <span className={`size-2 rounded-full ${col.dotColor}`} />
                    {col.label}
                  </span>
                  <Badge
                    variant="secondary"
                    className="font-mono text-xs px-2 py-0.5"
                  >
                    {jobs.length}
                  </Badge>
                </div>

                {/* Cards Container */}
                <div className="p-3 flex flex-col gap-2.5 overflow-y-auto min-h-[160px]">
                  {jobs.map((job: JobListing) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      onAdvance={status => advance(job, status)}
                    />
                  ))}
                  {jobs.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground/40 border border-dashed border-border/60 rounded-lg">
                      <Inbox className="size-6 mb-2" />
                      <span className="text-xs">No positions</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <AddJobDialog
        open={addJobOpen}
        onOpenChange={setAddJobOpen}
        onSubmit={payload =>
          addJob.mutate(payload, {
            onSuccess: () => {
              toast.success("Job added")
              setAddJobOpen(false)
            },
            onError: (e: { message?: string }) =>
              toast.error("Couldn't add job", { description: e?.message }),
          })
        }
        pending={addJob.isPending}
      />

      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </div>
  )
}

// ── Add-job dialog ────────────────────────────────────────────────────────
// Manual entry — useful when the agent hasn't surfaced a listing yet but
// the user found one themselves (paste a URL + meta so it lands in
// "discovered"). Posts to POST /api/jobs which dedupes by URL.
function AddJobDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (payload: Record<string, unknown>) => void
  pending: boolean
}) {
  const [title, setTitle] = useState("")
  const [company, setCompany] = useState("")
  const [url, setUrl] = useState("")

  const canSubmit = title.trim() && company.trim()

  const submit = () => {
    if (!canSubmit) return
    onSubmit({
      title: title.trim(),
      company: company.trim(),
      url: url.trim() || null,
      source: "manual",
      status: "discovered",
    })
    setTitle("")
    setCompany("")
    setUrl("")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!pending) onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a job manually</DialogTitle>
          <DialogDescription>
            Paste a posting you found yourself. It lands in
            &ldquo;Discovered&rdquo; and the agent picks it up from there.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="job-title"
              className="text-xs text-muted-foreground"
            >
              Title
            </Label>
            <Input
              id="job-title"
              placeholder="e.g. Senior TypeScript Engineer"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="job-company"
              className="text-xs text-muted-foreground"
            >
              Company
            </Label>
            <Input
              id="job-company"
              placeholder="e.g. Acme"
              value={company}
              onChange={e => setCompany(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job-url" className="text-xs text-muted-foreground">
              URL (optional)
            </Label>
            <Input
              id="job-url"
              placeholder="https://…"
              value={url}
              onChange={e => setUrl(e.target.value)}
              className="text-xs font-mono"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || pending}>
            {pending ? "Adding…" : "Add job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sources dialog ────────────────────────────────────────────────────────
// Job-source CRUD — backs GET/POST/PUT/DELETE /api/job-sources. The agent
// refuses to browse any URL whose origin doesn't match an enabled row here
// (the runtime guard lives in src/agents/job-agent.ts → search_site /
// fetch_page). Replaces the legacy dashboard's Sources modal.
function SourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { data: sources, isLoading } = useJobSources()
  const addSource = useAddJobSource()
  const updateSource = useUpdateJobSource()
  const deleteSource = useDeleteJobSource()
  const [draft, setDraft] = useState({
    name: "",
    baseUrl: "",
    notes: "",
  })

  const list: JobSource[] = Array.isArray(sources) ? sources : []

  const handleAdd = () => {
    if (!draft.name || !draft.baseUrl) {
      toast.error("Name and base URL are required")
      return
    }
    addSource.mutate(
      {
        name: draft.name,
        baseUrl: draft.baseUrl,
        notes: draft.notes || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Source added")
          setDraft({ name: "", baseUrl: "", notes: "" })
        },
        onError: (e: { message?: string }) =>
          toast.error("Couldn't add source", { description: e?.message }),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Job sources</DialogTitle>
          <DialogDescription>
            Sites the agent is allowed to browse. Provide a name and the base
            URL; the agent loads the site and follows links to job postings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Input
                placeholder="Name (e.g. Reed)"
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                className="text-xs"
              />
              <Input
                placeholder="Base URL (https://example.com)"
                value={draft.baseUrl}
                onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                className="text-xs font-mono"
              />
            </div>
            <Input
              placeholder="Notes (optional)"
              value={draft.notes}
              onChange={e => setDraft({ ...draft, notes: e.target.value })}
              className="text-xs"
            />
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={addSource.isPending}
            >
              <Plus className="size-3.5 mr-1.5" />
              {addSource.isPending ? "Adding…" : "Add source"}
            </Button>
          </div>

          {isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : list.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
              No sources yet. Add one above so the agent has something to
              browse.
            </div>
          ) : (
            <ul className="flex flex-col gap-2 max-h-72 overflow-auto">
              {list.map(s => (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-2 p-3 rounded-lg border border-border bg-background"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-foreground">
                        {s.name}
                      </span>
                      {!s.enabled && (
                        <Badge variant="outline" className="text-[10px]">
                          disabled
                        </Badge>
                      )}
                    </div>
                    <code className="block text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                      {s.baseUrl}
                    </code>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updateSource.isPending}
                      onClick={() =>
                        updateSource.mutate({
                          id: s.id,
                          patch: { enabled: !s.enabled },
                        })
                      }
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      disabled={deleteSource.isPending}
                      title={`Delete source ${s.name}`}
                      aria-label={`Delete source ${s.name}`}
                      onClick={() =>
                        deleteSource.mutate(s.id, {
                          onSuccess: () => toast.success("Source removed"),
                          onError: (e: { message?: string }) =>
                            toast.error("Couldn't remove source", {
                              description: e?.message,
                            }),
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function JobCard({
  job,
  onAdvance,
}: {
  job: JobListing
  onAdvance: (status: JobStatus) => void
}) {
  const order: JobStatus[] = [
    "discovered",
    "draft",
    "applied",
    "interview",
    "offer",
  ]
  const idx = order.indexOf(job.status)
  const next: JobStatus | null =
    idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null
  const score = job.matchScore != null ? Math.round(job.matchScore * 100) : null

  return (
    <Card className="py-3 px-3.5 transition-all duration-150 hover:border-primary/40 shadow-sm">
      <CardContent className="p-0 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold text-sm leading-snug text-foreground">
            {job.title}
          </div>
          {score != null && (
            <Badge
              variant="secondary"
              className="font-mono text-[11px] shrink-0 bg-primary/10 text-primary border-primary/20"
            >
              {score}%
            </Badge>
          )}
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          {job.company}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-border/60">
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              Link <ExternalLink className="size-3" />
            </a>
          ) : (
            <span />
          )}

          {next && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onAdvance(next)}
            >
              Advance <ArrowRight className="size-3 ml-1" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

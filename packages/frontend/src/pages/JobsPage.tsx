import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ArrowRight,
  BellRing,
  CircleAlert,
  ExternalLink,
  Inbox,
  MoreHorizontal,
  Plus,
  Search,
  Globe,
  StickyNote,
  Trash2,
  CornerDownRight,
} from "lucide-react"
import {
  usePipeline,
  useSetJobStatus,
  useAddJob,
  useDeleteJob,
  useJobSources,
  useAddJobSource,
  useDeleteJobSource,
  useUpdateJobSource,
  useDueFollowUps,
} from "../hooks/queries"
import type { JobListing, JobStatus, JobSource } from "@/types"
import { STATUS_META, STATUS_ORDER, nextStatus, canTransition } from "@/lib/status"
import { formatRelative } from "@/lib/format"
import { safeHttpUrl } from "@/lib/safeUrl"
import {
  Badge,
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Label,
  Skeleton,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@agent-harness/ui"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { toast } from "sonner"

const isJobStatus = (s: string): s is JobStatus =>
  (STATUS_ORDER as string[]).includes(s)

export function JobsPage() {
  const { data: pipeline, isLoading, isError, error, refetch } = usePipeline()
  const setJobStatus = useSetJobStatus()
  const addJob = useAddJob()
  const deleteJob = useDeleteJob()
  const { data: dueFollowUps } = useDueFollowUps()
  const navigate = useNavigate()
  const router = useRouter()

  // URL-bound filters (?q= & ?status=) — shareable and deep-linkable from the
  // Overview stat cards.
  const search = useSearch({ from: "/_app/jobs/" })
  const [q, setQ] = useState(search.q ?? "")
  useEffect(() => {
    setQ(search.q ?? "")
  }, [search.q])
  const statusFilter = isJobStatus(search.status ?? "") ? search.status : null

  const [addJobOpen, setAddJobOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [jobToDelete, setJobToDelete] = useState<JobListing | null>(null)

  // ── Drag state ──────────────────────────────────────────────────────────
  const [activeJobId, setActiveJobId] = useState<number | null>(null)
  const [overColumn, setOverColumn] = useState<JobStatus | null>(null)
  // After a completed drag the overlay unmounts over the card — swallow the
  // synthetic click so dropping doesn't also open the detail page.
  const suppressClick = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const listings = pipeline?.listings ?? []
  const dueJobIds = useMemo(
    () => new Set((dueFollowUps ?? []).map(f => f.jobId)),
    [dueFollowUps],
  )

  const searchLower = useMemo(() => q.toLowerCase(), [q])

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

  const activeJob = activeJobId != null
    ? listings.find(j => j.id === activeJobId) ?? null
    : null

  // ── Moves ───────────────────────────────────────────────────────────────
  const move = useCallback(
    (job: JobListing, status: JobStatus, silent = false) => {
      if (job.status === status) return
      setJobStatus.mutate(
        { jobId: job.id, status },
        {
          onSuccess: () => {
            if (!silent) toast.success(`Moved to ${STATUS_META[status].label}`)
          },
          onError: (e: { message?: string }) =>
            toast.error("Couldn't update job status", {
              description: e?.message,
            }),
        },
      )
    },
    [setJobStatus],
  )

  const openJob = useCallback(
    (jobId: number) => navigate({ to: "/jobs/$jobId", params: { jobId } }),
    [navigate],
  )

  // Resolve which column a drop target belongs to: either the column's own
  // droppable id (the status string) or a sortable card inside it.
  const statusFromOverId = (
    overId: string | number | null | undefined,
  ): JobStatus | null => {
    if (overId == null) return null
    const s = String(overId)
    if (isJobStatus(s)) return s
    const job = listings.find(j => j.id === Number(s))
    return job ? job.status : null
  }

  const onDragStart = (e: DragStartEvent) => {
    setActiveJobId(Number(e.active.id))
  }

  const onDragOver = (e: DragOverEvent) => {
    setOverColumn(statusFromOverId(e.over?.id))
  }

  const onDragEnd = (e: DragEndEvent) => {
    const target = statusFromOverId(e.over?.id)
    const jobId = Number(e.active.id)
    const job = listings.find(j => j.id === jobId)
    setActiveJobId(null)
    setOverColumn(null)
    if (target && job && job.status !== target) {
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 120)
      // Silent: a toast on every drag is noise; rollback toasts on failure.
      move(job, target, true)
    }
  }

  const onDragCancel = () => {
    setActiveJobId(null)
    setOverColumn(null)
  }

  const handleCardActivate = (job: JobListing) => {
    if (suppressClick.current) return
    openJob(job.id)
  }

  const handleDelete = () => {
    if (!jobToDelete) return
    deleteJob.mutate(jobToDelete.id, {
      onSuccess: () => {
        toast.success("Job removed")
        setJobToDelete(null)
      },
      onError: (e: { message?: string }) =>
        toast.error("Couldn't remove job", { description: e?.message }),
    })
  }

  const setQuery = (value: string) => {
    setQ(value)
    void router.navigate({
      to: "/jobs",
      search: prev => ({ ...prev, q: value || undefined }),
      replace: true,
    })
  }

  return (
    <div className="p-8 space-y-6 animate-fade-in flex flex-col h-full">
      {/* Header & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Jobs
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Drag cards between stages, or open one to review its documents.
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <div className="relative w-64 max-w-full">
            <Search className="size-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Search title or company…"
              value={q}
              onChange={e => setQuery(e.target.value)}
              className="pl-9 h-9 text-sm"
              aria-label="Search jobs"
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

      {/* Kanban Board */}
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
          {STATUS_ORDER.map(col => (
            <Skeleton
              key={col}
              className="w-[320px] xl:w-[360px] shrink-0 h-96 rounded-xl"
            />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div className="flex gap-4 overflow-x-auto pb-4 flex-1 items-start">
            {STATUS_ORDER.map((status, colIdx) => (
              <BoardColumn
                key={status}
                status={status}
                jobs={byStage[status]}
                colIdx={colIdx}
                highlighted={overColumn === status}
                filtered={statusFilter === status}
                dueJobIds={dueJobIds}
                onCardActivate={handleCardActivate}
                onMove={move}
                onOpen={openJob}
                onDelete={setJobToDelete}
              />
            ))}
          </div>

          <DragOverlay>
            {activeJob ? (
              <JobCard
                job={activeJob}
                due={dueJobIds.has(activeJob.id)}
                dragging
              />
            ) : null}
          </DragOverlay>
        </DndContext>
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

      <ConfirmDialog
        open={jobToDelete != null}
        onOpenChange={v => {
          if (!v) setJobToDelete(null)
        }}
        title={`Remove "${jobToDelete?.title ?? ""}"?`}
        description="This permanently deletes the job, its cover letters, tailored CVs, and follow-ups."
        confirmLabel="Remove job"
        onConfirm={handleDelete}
        pending={deleteJob.isPending}
      />
    </div>
  )
}

// ── Kanban column ──────────────────────────────────────────────────────────
function BoardColumn({
  status,
  jobs,
  colIdx,
  highlighted,
  filtered,
  dueJobIds,
  onCardActivate,
  onMove,
  onOpen,
  onDelete,
}: {
  status: JobStatus
  jobs: JobListing[]
  colIdx: number
  highlighted: boolean
  filtered: boolean
  dueJobIds: Set<number>
  onCardActivate: (job: JobListing) => void
  onMove: (job: JobListing, status: JobStatus, silent?: boolean) => void
  onOpen: (jobId: number) => void
  onDelete: (job: JobListing) => void
}) {
  const meta = STATUS_META[status]
  // The card list itself is the drop zone, so EMPTY columns accept drops too.
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    data: { type: "column", status },
  })

  return (
    <div
      data-testid="kanban-column"
      data-column={status}
      className={cn(
        "w-[320px] xl:w-[360px] shrink-0 bg-card rounded-xl border-t-2 flex flex-col max-h-full animate-slide-up stagger-child transition-shadow",
        meta.accentClass,
        highlighted || isOver
          ? "border-x-border border-b-border ring-2 ring-primary/40"
          : "border border-border",
        filtered && "border-x-primary/40 border-b-primary/40",
      )}
      style={{ "--stagger-i": colIdx } as React.CSSProperties}
    >
      {/* Column header — dot + label + count */}
      <div className="bg-card px-4 py-3.5 flex items-center justify-between border-b border-border rounded-t-xl shrink-0">
        <span className="text-sm font-semibold flex items-center gap-2">
          <span className={cn("size-2 rounded-full", meta.dotClass)} />
          {meta.label}
        </span>
        <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5">
          {jobs.length}
        </Badge>
      </div>

      {/* Cards container (drop zone) */}
      <SortableContext
        items={jobs.map(j => j.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="p-3 flex flex-col gap-2.5 overflow-y-auto min-h-[160px]"
        >
          {jobs.map(job => (
            <SortableJobCard
              key={job.id}
              job={job}
              due={dueJobIds.has(job.id)}
              onActivate={() => onCardActivate(job)}
              onMove={onMove}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          ))}
          {jobs.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground/50 border border-dashed border-border rounded-lg">
              <Inbox className="size-6 mb-2" />
              <span className="text-xs">No positions here yet</span>
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

// ── Sortable wrapper around the visual card ───────────────────────────────
function SortableJobCard({
  job,
  due,
  onActivate,
  onMove,
  onOpen,
  onDelete,
}: {
  job: JobListing
  due: boolean
  onActivate: () => void
  onMove: (job: JobListing, status: JobStatus, silent?: boolean) => void
  onOpen: (jobId: number) => void
  onDelete: (job: JobListing) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: job.id, data: { type: "job", status: job.status } })

  // Enter opens the detail page; every other key (Space to lift, arrows to
  // move) still reaches the KeyboardSensor's own handler.
  const sensorKeyDown = listeners?.onKeyDown as
    | ((e: React.KeyboardEvent) => void)
    | undefined

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...listeners}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault()
          onActivate()
          return
        }
        sensorKeyDown?.(e)
      }}
    >
      <JobCard
        job={job}
        due={due}
        onActivate={onActivate}
        onMove={onMove}
        onOpen={onOpen}
        onDelete={onDelete}
      />
    </div>
  )
}

// ── The visual card (list + DragOverlay share it) ─────────────────────────
function JobCard({
  job,
  due,
  dragging,
  onActivate,
  onMove,
  onOpen,
  onDelete,
}: {
  job: JobListing
  due: boolean
  dragging?: boolean
  onActivate?: () => void
  onMove?: (job: JobListing, status: JobStatus, silent?: boolean) => void
  onOpen?: (jobId: number) => void
  onDelete?: (job: JobListing) => void
}) {
  const next = nextStatus(job.status)
  const score = job.matchScore != null ? Math.round(job.matchScore * 100) : null
  const targets = STATUS_ORDER.filter(s => canTransition(job.status, s))

  return (
    <Card
      data-testid="job-card"
      data-job-status={job.status}
      className={cn(
        "py-3 px-3.5 transition-colors duration-150 border-border",
        dragging
          ? "shadow-lg rotate-1 cursor-grabbing"
          : "cursor-grab hover:border-primary/40",
      )}
    >
      <CardContent className="p-0 space-y-2.5">
        <div
          className="flex items-start justify-between gap-2"
          onClick={onActivate}
        >
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-snug text-foreground truncate">
              {job.title}
            </div>
            <div className="text-xs text-muted-foreground font-medium truncate">
              {job.company}
            </div>
          </div>
          {score != null && (
            <Badge
              variant="ghost"
              className="font-mono text-[11px] shrink-0 bg-primary/10 text-blue-700 border-primary/20"
            >
              {score}%
            </Badge>
          )}
        </div>

        {/* Metadata row — source, relative date, notes, due follow-up */}
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
          {job.source && (
            <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-medium">
              {job.source}
            </span>
          )}
          <span>{formatRelative(job.createdAt)}</span>
          {job.notes && (
            <StickyNote
              className="size-3 text-muted-foreground/70"
              aria-label="Has notes"
            />
          )}
          {due && (
            <span className="inline-flex items-center gap-1 text-amber-700 bg-warning/10 border border-warning/25 rounded px-1.5 py-0.5 font-medium">
              <BellRing className="size-3" />
              Follow up
            </span>
          )}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-border/60">
          {safeHttpUrl(job.url) ? (
            <a
              href={safeHttpUrl(job.url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              onClick={e => e.stopPropagation()}
              aria-label={`Open posting for ${job.title}`}
            >
              Link <ExternalLink className="size-3" />
            </a>
          ) : (
            <span />
          )}

          <div
            className="flex items-center gap-1"
            onPointerDown={e => e.stopPropagation()}
          >
            {next && onMove && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onMove(job, next)}
              >
                Advance <ArrowRight className="size-3 ml-1" />
              </Button>
            )}
            {onOpen && onDelete && onMove && (
              <CardMenu
                job={job}
                targets={targets}
                onOpen={() => onOpen(job.id)}
                onMove={s => onMove(job, s)}
                onDelete={() => onDelete(job)}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Card overflow menu — Open / Move to… / Reject / Remove ────────────────
function CardMenu({
  job,
  targets,
  onOpen,
  onMove,
  onDelete,
}: {
  job: JobListing
  targets: JobStatus[]
  onOpen: () => void
  onMove: (status: JobStatus) => void
  onDelete: () => void
}) {
  const forward = targets.filter(s => s !== "rejected")
  const canReject = targets.includes("rejected")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={`Actions for ${job.title}`}
          data-testid="job-card-menu"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>
          <ExternalLink className="size-4" />
          Open details
        </DropdownMenuItem>
        {forward.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CornerDownRight className="size-4" />
              Move to…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {forward.map(s => (
                <DropdownMenuItem key={s} onSelect={() => onMove(s)}>
                  {STATUS_META[s].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {canReject && (
          <DropdownMenuItem onSelect={() => onMove("rejected")}>
            Mark rejected
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
            <Label htmlFor="job-title">Title</Label>
            <Input
              id="job-title"
              placeholder="e.g. Senior TypeScript Engineer"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job-company">Company</Label>
            <Input
              id="job-company"
              placeholder="e.g. Acme"
              value={company}
              onChange={e => setCompany(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job-url">URL (optional)</Label>
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
// fetch_page).
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
                aria-label="Source name"
              />
              <Input
                placeholder="Base URL (https://example.com)"
                value={draft.baseUrl}
                onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                className="text-xs font-mono"
                aria-label="Source base URL"
              />
            </div>
            <Input
              placeholder="Notes (optional)"
              value={draft.notes}
              onChange={e => setDraft({ ...draft, notes: e.target.value })}
              aria-label="Source notes"
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

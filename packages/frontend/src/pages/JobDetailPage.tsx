import { useMemo, useState } from "react"
import {
  Link,
  useNavigate,
  useParams,
} from "@tanstack/react-router"
import {
  ArrowLeft,
  BellPlus,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  FileCheck2,
  Loader2,
  Printer,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react"
import {
  useJob,
  useUpdateJob,
  useDeleteJob,
  useSetJobStatus,
  useGenerateCoverLetter,
  useGenerateTailoredCv,
  useAddFollowUp,
  useUpdateFollowUp,
  useDeleteFollowUp,
  useStatus,
  useBrowserStatus,
  useStartRun,
} from "../hooks/queries"
import type { JobStatus } from "@/types"
import { STATUS_META, STATUS_ORDER, canTransition } from "@/lib/status"
import { formatAbsolute, formatRelative } from "@/lib/format"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  cn,
} from "@agent-harness/ui"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { Markdown } from "../components/markdown"
import { toast } from "sonner"
import { useTabParam } from "../hooks/use-tab-param"

// Tab values for the detail view (?tab=… in the URL — shareable/refresh-safe).
const JOB_TABS = ["description", "cover-letters", "tailored-cvs", "follow-ups"] as const
type JobTab = (typeof JOB_TABS)[number]

export function JobDetailPage() {
  const { jobId } = useParams({ from: "/_app/jobs/$jobId" })
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch } = useJob(jobId)

  const setJobStatus = useSetJobStatus()
  const updateJob = useUpdateJob()
  const deleteJob = useDeleteJob()
  const generateCoverLetter = useGenerateCoverLetter()
  const generateTailoredCv = useGenerateTailoredCv()
  const addFollowUp = useAddFollowUp()
  const updateFollowUp = useUpdateFollowUp()
  const deleteFollowUp = useDeleteFollowUp()

  const { data: agentStatus } = useStatus()
  const { data: browserStatus } = useBrowserStatus()
  const startRun = useStartRun()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [jobTab, setJobTab] = useTabParam("tab", JOB_TABS, "description")

  const listing = data?.listing ?? null
  const coverLetters = data?.coverLetters ?? []
  const tailoredCvs = data?.tailoredCvs ?? []
  const followUps = useMemo(
    () =>
      [...(data?.followUps ?? [])].sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1
        return a.dueDate.localeCompare(b.dueDate)
      }),
    [data?.followUps],
  )

  const moveTargets = listing
    ? STATUS_ORDER.filter(s => canTransition(listing.status, s))
    : []
  const score =
    listing?.matchScore != null ? Math.round(listing.matchScore * 100) : null

  const agentRunning = agentStatus?.status === "running"
  const browserConnected =
    browserStatus?.target === "live" || browserStatus?.target === "managed"

  // ── Actions ─────────────────────────────────────────────────────────────
  const changeStatus = (status: JobStatus) => {
    if (!listing) return
    setJobStatus.mutate(
      { jobId: listing.id, status },
      {
        onSuccess: () =>
          toast.success(`Moved to ${STATUS_META[status].label}`),
        onError: (e: { message?: string }) =>
          toast.error("Couldn't update status", { description: e?.message }),
      },
    )
  }

  const handleApplyWithAgent = () => {
    if (!listing) return
    const goal =
      `Open the posting for "${listing.title}" at ${listing.company}` +
      ` (${listing.url ?? "no URL on file"}) in my paired browser and assist me in filling out ` +
      `the application using my tailored documents. Never submit the application yourself and never log in.`
    startRun.mutate(
      { goal },
      {
        onSuccess: () =>
          toast.success("Assisted apply run started", {
            description: "Follow it live on the Traces page.",
            action: {
              label: "View",
              onClick: () => void navigate({ to: "/traces" }),
            },
          }),
        onError: (e: { message?: string }) =>
          toast.error("Couldn't start the run", { description: e?.message }),
      },
    )
  }

  const handleGenerateCoverLetter = () => {
    if (!listing) return
    generateCoverLetter.mutate(listing.id, {
      onSuccess: r =>
        toast.success(`Cover letter v${r.version} generated`),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't generate cover letter", {
          description: e?.message,
        }),
    })
  }

  const handleGenerateTailoredCv = () => {
    if (!listing) return
    generateTailoredCv.mutate(listing.id, {
      onSuccess: r => toast.success(`Tailored CV v${r.version} generated`),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't tailor CV", { description: e?.message }),
    })
  }

  const handleDelete = () => {
    if (!listing) return
    deleteJob.mutate(listing.id, {
      onSuccess: () => {
        toast.success("Job removed")
        void navigate({ to: "/jobs" })
      },
      onError: (e: { message?: string }) =>
        toast.error("Couldn't remove job", { description: e?.message }),
    })
  }

  // ── States ──────────────────────────────────────────────────────────────
  if (isError) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <BackLink />
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load job</p>
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
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <BackLink />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  if (!listing) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <BackLink />
        <Card>
          <CardContent className="py-16 text-center">
            <CircleAlert className="size-8 mx-auto mb-3 text-muted-foreground/50" />
            <p className="text-sm font-medium">Job not found</p>
            <p className="text-xs text-muted-foreground mt-1">
              It may have been removed.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const meta = STATUS_META[listing.status]

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      <BackLink />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="space-y-4 pb-6 border-b border-border">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge variant="ghost" className={meta.badgeClass}>
                {meta.label}
              </Badge>
              {listing.source && (
                <Badge variant="secondary" className="text-[11px]">
                  {listing.source}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                added {formatRelative(listing.createdAt)}
              </span>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight text-foreground"
              data-testid="job-detail-title"
            >
              {listing.title}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {listing.company}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {listing.url && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={listing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open the posting for ${listing.title}`}
                >
                  Apply <ExternalLink className="size-3.5 ml-1" />
                </a>
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleApplyWithAgent}
              disabled={agentRunning || !browserConnected || startRun.isPending}
              title={
                agentRunning
                  ? "An agent run is already active"
                  : !browserConnected
                    ? "Connect your browser (Settings → Browser) first"
                    : "Start a focused agent run that opens this posting in your browser and assists"
              }
              data-testid="apply-with-agent"
            >
              <Sparkles className="size-3.5 mr-1.5" />
              Apply with agent
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5 mr-1.5" />
              Remove
            </Button>
          </div>
        </div>

        {/* Meta strip: status select · match · timestamps */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Stage</span>
            <Select
              value={listing.status}
              onValueChange={v => changeStatus(v as JobStatus)}
            >
              <SelectTrigger
                className="h-8 w-36 text-xs"
                aria-label="Change job stage"
                data-testid="job-status-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={listing.status}>
                  {meta.label} (current)
                </SelectItem>
                {moveTargets.map(s => (
                  <SelectItem key={s} value={s}>
                    {STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {score != null && (
            <div className="flex items-center gap-2 min-w-40">
              <span className="text-xs text-muted-foreground">Match</span>
              <Progress
                value={score}
                className="h-1.5 w-24"
                aria-label={`Match score ${score}%`}
              />
              <span className="text-xs font-semibold tabular-nums">
                {score}%
              </span>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            updated {formatAbsolute(listing.updatedAt)}
          </div>
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <Tabs value={jobTab} onValueChange={v => setJobTab(v as JobTab)}>
        <TabsList>
          <TabsTrigger value="description">Description</TabsTrigger>
          <TabsTrigger value="cover-letters">
            Cover letters
            <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">
              {coverLetters.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="tailored-cvs">
            Tailored CVs
            <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">
              {tailoredCvs.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="follow-ups">
            Follow-ups
            <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">
              {followUps.filter(f => !f.completed).length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="description" className="mt-4">
          <DescriptionTab
            listing={{
              description: listing.description,
              notes: listing.notes,
              priority: listing.priority,
            }}
            onSave={(notes, priority) =>
              updateJob.mutate(
                { jobId: listing.id, notes, priority },
                {
                  onSuccess: () => toast.success("Job updated"),
                  onError: (e: { message?: string }) =>
                    toast.error("Couldn't save", { description: e?.message }),
                },
              )
            }
            pending={updateJob.isPending}
          />
        </TabsContent>

        <TabsContent value="cover-letters" className="mt-4">
          <DocumentsTab
            kind="cover-letter"
            items={coverLetters.map(c => ({
              id: c.id,
              version: c.version,
              content: c.content,
              createdAt: c.createdAt,
            }))}
            onGenerate={handleGenerateCoverLetter}
            generating={generateCoverLetter.isPending}
            generateLabel={
              coverLetters.length === 0 ? "Generate cover letter" : "Regenerate"
            }
          />
        </TabsContent>

        <TabsContent value="tailored-cvs" className="mt-4">
          <DocumentsTab
            kind="tailored-cv"
            items={tailoredCvs.map(c => ({
              id: c.id,
              version: c.version,
              content: c.content,
              createdAt: c.createdAt,
            }))}
            onGenerate={handleGenerateTailoredCv}
            generating={generateTailoredCv.isPending}
            generateLabel={
              tailoredCvs.length === 0 ? "Tailor my CV" : "Regenerate"
            }
          />
        </TabsContent>

        <TabsContent value="follow-ups" className="mt-4">
          <FollowUpsTab
            followUps={followUps}
            onAdd={(dueDate, note) =>
              addFollowUp.mutate(
                { jobId: listing.id, dueDate, note },
                {
                  onSuccess: () => toast.success("Follow-up scheduled"),
                  onError: (e: { message?: string }) =>
                    toast.error("Couldn't add follow-up", {
                      description: e?.message,
                    }),
                },
              )
            }
            onComplete={(id, completed) =>
              updateFollowUp.mutate(
                { followUpId: id, completed },
                {
                  onError: (e: { message?: string }) =>
                    toast.error("Couldn't update follow-up", {
                      description: e?.message,
                    }),
                },
              )
            }
            onDelete={id =>
              deleteFollowUp.mutate(id, {
                onSuccess: () => toast.success("Follow-up removed"),
                onError: (e: { message?: string }) =>
                  toast.error("Couldn't remove follow-up", {
                    description: e?.message,
                  }),
              })
            }
            adding={addFollowUp.isPending}
          />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove "${listing.title}"?`}
        description="This permanently deletes the job, its cover letters, tailored CVs, and follow-ups."
        confirmLabel="Remove job"
        onConfirm={handleDelete}
        pending={deleteJob.isPending}
      />
    </div>
  )
}

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground -ml-2"
      asChild
    >
      <Link to="/jobs" data-testid="back-to-jobs">
        <ArrowLeft className="size-3.5 mr-1.5" />
        Back to board
      </Link>
    </Button>
  )
}

// ── Description tab: posting text + editable notes/priority ────────────────
function DescriptionTab({
  listing,
  onSave,
  pending,
}: {
  listing: { description: string | null; notes: string | null; priority: number }
  onSave: (notes: string, priority: number) => void
  pending: boolean
}) {
  const [notes, setNotes] = useState(listing.notes ?? "")
  const [priority, setPriority] = useState(String(listing.priority))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardContent className="p-5">
          <h2 className="text-sm font-semibold mb-3">Posting</h2>
          {listing.description ? (
            <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
              {listing.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No description was captured for this job. Open the posting link
              to read the original.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <h2 className="text-sm font-semibold">Your notes</h2>
          <div className="space-y-1.5">
            <Label htmlFor="job-notes" className="text-xs text-muted-foreground">
              Private notes (never sent to employers)
            </Label>
            <Textarea
              id="job-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Recruiter contact, salary range, prep notes…"
              className="min-h-28 text-sm"
              data-testid="job-notes"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="job-priority"
              className="text-xs text-muted-foreground"
            >
              Priority (1 high – 10 low)
            </Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger id="job-priority" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 10 }, (_, i) => i + 1).map(p => (
                  <SelectItem key={p} value={String(p)}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={pending}
            onClick={() => onSave(notes, Number(priority))}
            data-testid="save-job-notes"
          >
            {pending ? "Saving…" : "Save notes"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Documents tab: versioned cover letters / tailored CVs ──────────────────
interface DocItem {
  id: number
  version: number
  content: string
  createdAt: string
}

function DocumentsTab({
  kind,
  items,
  onGenerate,
  generating,
  generateLabel,
}: {
  kind: "cover-letter" | "tailored-cv"
  items: DocItem[]
  onGenerate: () => void
  generating: boolean
  generateLabel: string
}) {
  const icon = kind === "cover-letter" ? FileText : FileCheck2
  const Icon = icon

  const copy = (content: string) => {
    void navigator.clipboard.writeText(content).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't copy"),
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-md">
          {kind === "cover-letter"
            ? "Each generation creates a new version — review, copy, or print before applying."
            : "Each tailoring creates a new version, grounded in your real CV — nothing invented. Print to export as PDF."}
        </p>
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={generating}
          data-testid={`generate-${kind}`}
        >
          {generating ? (
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5 mr-1.5" />
          )}
          {generating
            ? "Writing…"
            : generateLabel}
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Icon className="size-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">
              No {kind === "cover-letter" ? "cover letters" : "tailored CVs"}{" "}
              yet
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              {kind === "cover-letter"
                ? "Generate one — the agent writes it from your profile and this posting."
                : "Generate one — the agent re-weights your real CV against this posting."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map(doc => (
            <Card key={doc.id} className="overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap bg-muted/30">
                <div className="flex items-center gap-2 text-sm">
                  <Icon className="size-4 text-primary" />
                  <span className="font-semibold">
                    Version {doc.version}
                  </span>
                  {doc === items[0] && (
                    <Badge variant="secondary" className="text-[10px]">
                      latest
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(doc.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => copy(doc.content)}
                  >
                    <Copy className="size-3.5 mr-1" />
                    Copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => window.print()}
                  >
                    <Printer className="size-3.5 mr-1" />
                    Print / PDF
                  </Button>
                </div>
              </div>
              {/* print-area: only this document is printed (print CSS in
                  index.css isolates it). */}
              <div
                className="print-area px-5 py-4"
                data-testid={`${kind}-content`}
              >
                <Markdown>{doc.content}</Markdown>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Follow-ups tab ─────────────────────────────────────────────────────────
function FollowUpsTab({
  followUps,
  onAdd,
  onComplete,
  onDelete,
  adding,
}: {
  followUps: Array<{
    id: number
    jobId: number
    dueDate: string
    note: string | null
    completed: boolean
  }>
  onAdd: (dueDate: string, note?: string) => void
  onComplete: (id: number, completed: boolean) => void
  onDelete: (id: number) => void
  adding: boolean
}) {
  const [dueDate, setDueDate] = useState("")
  const [note, setNote] = useState("")

  const defaultDate = () => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return d.toISOString().slice(0, 10)
  }

  const submit = () => {
    const date = dueDate || defaultDate()
    onAdd(date, note.trim() || undefined)
    setDueDate("")
    setNote("")
  }

  const open = followUps.filter(f => !f.completed)
  const done = followUps.filter(f => f.completed)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        {followUps.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <BellPlus className="size-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">
                No follow-ups
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                When this job moves to Applied, a nudge is created
                automatically — or add one yourself.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {open.length > 0 && (
              <ul className="flex flex-col gap-2" data-testid="follow-up-list">
                {open.map(f => (
                  <li key={f.id}>
                    <FollowUpRow
                      followUp={f}
                      onComplete={onComplete}
                      onDelete={onDelete}
                    />
                  </li>
                ))}
              </ul>
            )}
            {done.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Completed
                </p>
                <ul className="flex flex-col gap-2">
                  {done.map(f => (
                    <li key={f.id}>
                      <FollowUpRow
                        followUp={f}
                        onComplete={onComplete}
                        onDelete={onDelete}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <Card>
        <CardContent className="p-5 space-y-4">
          <h2 className="text-sm font-semibold">Schedule a nudge</h2>
          <div className="space-y-1.5">
            <Label
              htmlFor="follow-up-date"
              className="text-xs text-muted-foreground"
            >
              Due date
            </Label>
            <Input
              id="follow-up-date"
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              data-testid="follow-up-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="follow-up-note"
              className="text-xs text-muted-foreground"
            >
              Note (optional)
            </Label>
            <Input
              id="follow-up-note"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Ping recruiter about timeline"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={adding}
            onClick={submit}
            data-testid="add-follow-up"
          >
            {adding ? "Adding…" : "Add follow-up"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function FollowUpRow({
  followUp,
  onComplete,
  onDelete,
}: {
  followUp: {
    id: number
    dueDate: string
    note: string | null
    completed: boolean
  }
  onComplete: (id: number, completed: boolean) => void
  onDelete: (id: number) => void
}) {
  const due = new Date(followUp.dueDate + (followUp.dueDate.includes("T") ? "" : "T00:00:00Z"))
  const overdue = !followUp.completed && due.getTime() < Date.now()

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border bg-card",
        followUp.completed
          ? "border-border opacity-60"
          : overdue
            ? "border-warning/40 bg-warning/5"
            : "border-border",
      )}
    >
      <Button
        variant="outline"
        size="icon"
        className="size-6 shrink-0"
        aria-label={
          followUp.completed ? "Mark as open" : "Mark as done"
        }
        onClick={() => onComplete(followUp.id, !followUp.completed)}
      >
        {followUp.completed && <Check className="size-3.5" />}
      </Button>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {due.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          {overdue && (
            <span className="ml-2 text-xs font-medium text-amber-700">
              overdue
            </span>
          )}
          {followUp.completed && (
            <span className="ml-2 text-xs text-muted-foreground">done</span>
          )}
        </div>
        {followUp.note && (
          <p className="text-xs text-muted-foreground truncate">
            {followUp.note}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        aria-label="Delete follow-up"
        onClick={() => onDelete(followUp.id)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

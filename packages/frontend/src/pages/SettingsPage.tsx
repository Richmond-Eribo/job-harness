// Tabbed settings page at `/settings`.
//
// Surfaces:
//   • Profile — embeds <ProfilePage /> unchanged (it owns its own header +
//     Save button). The existing 15-key edits-overlay + skills lives on it.
//   • LLM Config — runs + agent-loop settings exposed via /api/config
//     (provider / model / custom provider URL / maxSteps / tokenBudget /
//     goal). Read-only: tokensUsed.
//   • Browser & Extension — relay status + extension pairing flow (Phase 0/1).
//   • Schedules — cron-driven agent schedules CRUD (Phase 4 — was only in
//     the now-deleted legacy dashboard).
//   • Account — sign out / export data / delete account (Phase 4). Closes
//     the gap with the LandingPage's "Export or delete everything from
//     Settings whenever you want" marketing claim.
//
// The tabs are pure local state — no URL hash — so refresh resets to
// Profile. Fine for now; add ?tab=... if users complain.

import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import {
  Cpu,
  User as UserIcon,
  CircleAlert,
  Chrome,
  Calendar,
  UserCog,
} from "lucide-react"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@agent-harness/ui"
import { toast } from "sonner"
import { ProfilePage } from "./ProfilePage"
import {
  useConfig,
  useUpdateConfig,
  useBrowserStatus,
  usePairExtension,
  useDisconnectBrowser,
  useUnpairAllBrowsers,
  useProbeBrowser,
  useSchedules,
  useAddSchedule,
  useDeleteSchedule,
  useToggleSchedule,
} from "../hooks/queries"
import { api } from "../lib/api"
import { signOutClient } from "../lib/auth"
import type { ScheduleEntry } from "@/types"

type Tab = "profile" | "llm" | "browser" | "schedules" | "account"

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("profile")

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="border-b border-border pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage your profile, agent behavior, and LLM configuration.
        </p>
      </div>

      {/* Tab bar */}
      <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="profile">
            <UserIcon className="size-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="llm">
            <Cpu className="size-4" />
            LLM Config
          </TabsTrigger>
          <TabsTrigger value="browser">
            <Chrome className="size-4" />
            Browser &amp; Extension
          </TabsTrigger>
          <TabsTrigger value="schedules">
            <Calendar className="size-4" />
            Schedules
          </TabsTrigger>
          <TabsTrigger value="account">
            <UserCog className="size-4" />
            Account
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Tab body */}
      {tab === "profile" ? (
        <ProfileTab />
      ) : tab === "llm" ? (
        <LlmConfigTab />
      ) : tab === "schedules" ? (
        <SchedulesTab />
      ) : tab === "account" ? (
        <AccountTab />
      ) : (
        <BrowserExtensionTab />
      )}
    </div>
  )
}

// Profile tab — the self-contained ProfilePage. It has its own header +
// Save button; the settings-page header above is the only decoration.
// (Wrapping in a div to opt-out of the parent's space-y-6 spacing.)
function ProfileTab() {
  return (
    <div className="-mt-6">
      <ProfilePage />
    </div>
  )
}

// LLM + runtime config tab — backs GET/PUT /api/config.
function LlmConfigTab() {
  const { data: config, isLoading, isError, error, refetch } = useConfig()
  const updateConfig = useUpdateConfig()
  const [edits, setEdits] = useState<Record<string, string>>({})

  // Display value: user override ?? server value ?? ""
  const v = (k: string): string => edits[k] ?? String(config?.[k] ?? "")

  const set = (k: string, value: string) =>
    setEdits(prev => ({ ...prev, [k]: value }))

  const save = () => {
    if (Object.keys(edits).length === 0) {
      toast.info("Nothing to save")
      return
    }
    updateConfig.mutate(edits, {
      onSuccess: () => {
        toast.success("Configuration saved")
        setEdits({}) // server now has latest — overlay no longer needed
      },
      onError: (e: { message?: string }) =>
        toast.error("Couldn't save config", { description: e?.message }),
    })
  }

  if (isError) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="py-8 text-center">
          <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm font-medium">Failed to load configuration</p>
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
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const hasEdits = Object.keys(edits).length > 0

  return (
    <div className="flex flex-col gap-6">
      {/* Model Selection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="size-4 text-primary" />
            Model Selection
          </CardTitle>
          <CardDescription className="text-xs">
            Override the default model. Choose a provider protocol that matches
            your API gateway, then set a model id and (for compatible gateways)
            the base URL.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="llmProvider"
                className="text-xs text-muted-foreground"
              >
                Provider
              </Label>
              <Select
                value={v("llmProvider")}
                onValueChange={val => set("llmProvider", val)}
              >
                <SelectTrigger id="llmProvider" className="text-xs">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-compatible">
                    OpenAI compatible
                  </SelectItem>
                  <SelectItem value="anthropic-compatible">
                    Anthropic compatible
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground/80">
                OpenAI compatible: OpenAI, GLM, OpenRouter, xAI, Groq, Ollama.
                Anthropic compatible: Claude-style gateways.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="llmModel"
                className="text-xs text-muted-foreground"
              >
                Model ID
              </Label>
              <Input
                id="llmModel"
                placeholder="e.g. gpt-4o-mini"
                value={v("llmModel")}
                onChange={e => set("llmModel", e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="customProviderUrl"
              className="text-xs text-muted-foreground"
            >
              Custom Provider URL (optional)
            </Label>
            <Input
              id="customProviderUrl"
              placeholder="https://your-openai-compatible-gateway/v1"
              value={v("customProviderUrl")}
              onChange={e => set("customProviderUrl", e.target.value)}
              className="text-xs font-mono"
            />
          </div>
        </CardContent>
      </Card>

      {/* Agent Runtime */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Agent Runtime</CardTitle>
          <CardDescription className="text-xs">
            Limits that gate how much the harness does in a single run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="maxSteps"
                className="text-xs text-muted-foreground"
              >
                Max Steps
              </Label>
              <Input
                id="maxSteps"
                type="number"
                placeholder="100"
                value={v("maxSteps")}
                onChange={e => set("maxSteps", e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="tokenBudget"
                className="text-xs text-muted-foreground"
              >
                Token Budget
              </Label>
              <Input
                id="tokenBudget"
                type="number"
                placeholder="0 = unlimited"
                value={v("tokenBudget")}
                onChange={e => set("tokenBudget", e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="tokensUsed"
                className="text-xs text-muted-foreground"
              >
                Tokens Used{" "}
                <span className="text-muted-foreground/60">(read-only)</span>
              </Label>
              <Input
                id="tokensUsed"
                value={v("tokensUsed")}
                disabled
                className="text-xs font-mono bg-muted/40"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goal" className="text-xs text-muted-foreground">
              Default Goal
            </Label>
            <Input
              id="goal"
              placeholder="e.g. Find 5 senior TypeScript roles in London"
              value={v("goal")}
              onChange={e => set("goal", e.target.value)}
              className="text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="flex items-center justify-between border-t border-border pt-5">
        <p className="text-xs text-muted-foreground">
          {hasEdits
            ? `${Object.keys(edits).length} unsaved change${Object.keys(edits).length === 1 ? "" : "s"}`
            : "All changes saved"}
        </p>
        <Button
          onClick={save}
          disabled={!hasEdits || updateConfig.isPending}
          size="sm"
        >
          {updateConfig.isPending ? "Saving…" : "Save Configuration"}
        </Button>
      </div>
    </div>
  )
}

// Browser & Extension tab — the ONLY place in the React app that surfaces
// whether the agent has a live browser target (previously this existed only
// in the now-deleted legacy public/ dashboard). Backs GET /api/browser/status
// and the pairing flow (POST /api/browser/pair → a 6-char code the extension
// popup redeems).
function BrowserExtensionTab() {
  const { data: status, isLoading, isError, error, refetch } = useBrowserStatus()
  const pair = usePairExtension()
  const disconnect = useDisconnectBrowser()
  const unpairAll = useUnpairAllBrowsers()
  const probe = useProbeBrowser()
  const [probeUrl, setProbeUrl] = useState("")
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null)

  const handlePair = () => {
    pair.mutate(undefined, {
      onSuccess: data => {
        setPairing({ code: data.code, expiresAt: Date.now() + data.expiresIn * 1000 })
      },
      onError: (e: { message?: string }) =>
        toast.error("Couldn't generate a pairing code", { description: e?.message }),
    })
  }

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => toast.success("Browser disconnected"),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't disconnect", { description: e?.message }),
    })
  }

  const handleUnpairAll = () => {
    unpairAll.mutate(undefined, {
      onSuccess: d =>
        toast.success(
          d.revoked > 0
            ? `Revoked ${d.revoked} paired browser${d.revoked === 1 ? "" : "s"}`
            : "No paired browsers to revoke",
        ),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't revoke pairings", { description: e?.message }),
    })
  }

  const handleProbe = () => {
    if (!probeUrl.trim()) return
    probe.mutate(probeUrl.trim(), {
      onSuccess: () => toast.success("Probe succeeded — see result below"),
      onError: (e: { message?: string }) =>
        toast.error("Probe failed", { description: e?.message }),
    })
  }

  if (isError) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="py-8 text-center">
          <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm font-medium">Failed to load browser status</p>
          <p className="text-xs text-muted-foreground mt-1">
            {(error as { message?: string })?.message}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  const target = status?.target ?? "none"
  const targetLabel =
    target === "live" ? "Connected (your Chrome)" : target === "managed" ? "Connected (managed)" : "Not connected"
  const targetVariant = target === "none" ? "outline" : "default"

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Chrome className="size-4 text-primary" />
                Browser connection
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                The agent needs a connected browser to read login-walled job
                sites and (eventually) fill applications for your review.
              </CardDescription>
            </div>
            <Badge variant={targetVariant}>{targetLabel}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {target === "live" && status?.live?.connectedAt && (
            <p className="text-xs text-muted-foreground">
              Connected since {new Date(status.live.connectedAt).toLocaleString()}
              {status.live.userAgent ? ` · ${status.live.userAgent}` : ""}
            </p>
          )}

          {!pairing ? (
            <div className="flex items-center gap-2">
              <Button onClick={handlePair} disabled={pair.isPending} size="sm">
                {pair.isPending ? "Generating…" : "Pair new browser"}
              </Button>
              {target !== "none" && (
                <Button
                  onClick={handleDisconnect}
                  disabled={disconnect.isPending}
                  variant="outline"
                  size="sm"
                >
                  Disconnect
                </Button>
              )}
              <Button
                onClick={handleUnpairAll}
                disabled={unpairAll.isPending}
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                Forget all paired browsers
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Open the extension popup, enter this worker URL and code:
              </p>
              <p className="text-3xl font-mono font-bold tracking-[0.3em] text-primary">
                {pairing.code}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Expires{" "}
                {Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000 / 60))} min
                from now · single use
              </p>
              <Button variant="ghost" size="sm" onClick={() => setPairing(null)}>
                Done
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Browser test</CardTitle>
          <CardDescription className="text-xs">
            Navigate + observe a URL through the connected browser without a
            full agent run. Verifies the whole chain end-to-end.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              placeholder="https://example.com/jobs/123"
              value={probeUrl}
              onChange={e => setProbeUrl(e.target.value)}
              className="text-xs font-mono"
            />
            <Button onClick={handleProbe} disabled={probe.isPending} size="sm">
              {probe.isPending ? "Probing…" : "Probe"}
            </Button>
          </div>
          {probe.data != null && (
            <pre className="text-[11px] font-mono bg-muted/40 rounded-md p-3 overflow-auto max-h-64">
              {JSON.stringify(probe.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// Schedules tab — cron-driven agent schedules CRUD. Backs GET/POST/DELETE
// /api/schedules + PUT /api/schedules/:id/toggle. Previously this whole
// surface existed ONLY in the now-deleted legacy public/ dashboard; this is
// the React parity port (Phase 4).
function SchedulesTab() {
  const {
    data: schedules,
    isLoading,
    isError,
    error,
    refetch,
  } = useSchedules()
  const addSchedule = useAddSchedule()
  const deleteSchedule = useDeleteSchedule()
  const toggleSchedule = useToggleSchedule()
  const [cron, setCron] = useState("")
  const [focus, setFocus] = useState<"all" | "jobs">("all")

  const handleAdd = () => {
    if (!cron.trim()) {
      toast.error("Cron expression required")
      return
    }
    addSchedule.mutate(
      { cron: cron.trim(), focus },
      {
        onSuccess: () => {
          toast.success("Schedule added")
          setCron("")
        },
        onError: (e: { message?: string }) =>
          toast.error("Couldn't add schedule", { description: e?.message }),
      },
    )
  }

  if (isError) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="py-8 text-center">
          <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm font-medium">Failed to load schedules</p>
          <p className="text-xs text-muted-foreground mt-1">
            {(error as { message?: string })?.message}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return <Skeleton className="h-48 w-full rounded-xl" />
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Calendar className="size-4 text-primary" />
            Add a schedule
          </CardTitle>
          <CardDescription className="text-xs">
            Standard 5-field cron (UTC). The agent runs automatically at each
            fire if a run isn&apos;t already active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cron" className="text-xs text-muted-foreground">
                Cron expression
              </Label>
              <Input
                id="cron"
                placeholder="0 9 * * 1-5"
                value={cron}
                onChange={e => setCron(e.target.value)}
                className="text-xs font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="focus" className="text-xs text-muted-foreground">
                Focus
              </Label>
              <select
                id="focus"
                value={focus}
                onChange={e => setFocus(e.target.value as "all" | "jobs")}
                className="h-9 rounded-md border border-border bg-background px-3 text-xs"
              >
                <option value="all">all</option>
                <option value="jobs">jobs</option>
              </select>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={addSchedule.isPending || !cron.trim()}
          >
            {addSchedule.isPending ? "Adding…" : "Add schedule"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Active schedules</CardTitle>
          <CardDescription className="text-xs">
            {Array.isArray(schedules) ? schedules.length : 0} configured.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!Array.isArray(schedules) || schedules.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-xl">
              No schedules. Add one above to run the agent automatically.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {schedules.map((s: ScheduleEntry) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-background"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono font-semibold text-primary">
                        {s.cron}
                      </code>
                      <Badge variant="secondary" className="text-[10px]">
                        {s.focus}
                      </Badge>
                      {!s.enabled && (
                        <Badge variant="outline" className="text-[10px]">
                          paused
                        </Badge>
                      )}
                    </div>
                    {s.description && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {s.description}
                      </p>
                    )}
                    {s.nextFireAt && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                        next: {new Date(s.nextFireAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleSchedule.isPending}
                      onClick={() =>
                        toggleSchedule.mutate({ id: s.id, enabled: !s.enabled })
                      }
                    >
                      {s.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      disabled={deleteSchedule.isPending}
                      onClick={() =>
                        deleteSchedule.mutate(s.id, {
                          onSuccess: () => toast.success("Schedule removed"),
                          onError: (e: { message?: string }) =>
                            toast.error("Couldn't remove schedule", {
                              description: e?.message,
                            }),
                        })
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// Account tab — closes the gap with LandingPage's "Export or delete
// everything from Settings whenever you want" marketing claim. Three
// actions: export data (JSON download), sign out (everywhere on this
// device), and delete account (with type-to-confirm). Backed by
// GET /api/account/export + DELETE /api/account (Phase 4 backend routes).
function AccountTab() {
  const navigate = useNavigate()
  const [confirmText, setConfirmText] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)

  const EXPECTED = "delete my account"
  const canDelete = confirmText.trim().toLowerCase() === EXPECTED

  const handleExport = async () => {
    setExporting(true)
    try {
      // api.get goes through the credentials-aware fetch helper, but it
      // assumes JSON; for a downloadable blob, read the response directly.
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? ""}/api/account/export`,
        { credentials: "include" },
      )
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `job-agent-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Export downloaded")
    } catch (e: any) {
      toast.error("Couldn't export data", { description: e?.message })
    } finally {
      setExporting(false)
    }
  }

  const handleDelete = async () => {
    if (!canDelete) return
    setDeleting(true)
    try {
      const res = await api.del("/account")
      if (res == null) {
        // Account deleted on the server; clear local state and bounce to /.
        // signOutClient also hits /api/auth/sign-out which will 401 now (user
        // row gone), but the cookie is already invalid so this is best-effort.
        await signOutClient().catch(() => {})
        toast.success("Account deleted")
        await navigate({ to: "/", replace: true })
      }
    } catch (e: any) {
      toast.error("Couldn't delete account", { description: e?.message })
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Export your data</CardTitle>
          <CardDescription className="text-xs">
            Download a JSON snapshot of everything the agent stores for your
            account: profile, jobs, cover letters, follow-ups, schedules,
            memory, and recent run summaries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleExport} disabled={exporting} size="sm">
            {exporting ? "Exporting…" : "Download JSON export"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Sign out</CardTitle>
          <CardDescription className="text-xs">
            End this session on this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await signOutClient()
              await navigate({ to: "/login", replace: true })
            }}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-destructive">
            Delete account
          </CardTitle>
          <CardDescription className="text-xs">
            Permanently deletes your user row, every Durable Object scoped to
            your userId (harness, jobs, browser relay), your CV in R2, and all
            extension pairing tokens. This cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="confirm" className="text-xs text-muted-foreground">
              Type <code className="font-mono">{EXPECTED}</code> to confirm
            </Label>
            <Input
              id="confirm"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={EXPECTED}
              autoComplete="off"
              disabled={deleting}
            />
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={!canDelete || deleting}
          >
            {deleting ? "Deleting account…" : "Delete my account"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

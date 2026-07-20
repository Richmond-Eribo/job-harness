// Tabbed settings page at `/settings`.
//
// Two surfaces so far:
//   • Profile — embeds <ProfilePage /> unchanged (it owns its own header +
//     Save button). The existing 15-key edits-overlay + skills lives on it.
//   • LLM Config — runs + agent-loop settings exposed via /api/config
//     (provider / model / custom provider URL / maxSteps / tokenBudget /
//     goal). Read-only: tokensUsed.
//
// The tabs are pure local state — no URL hash — so refreshing stays on
// whichever tab the user last picked? No: refresh resets to Profile. That's
// fine for now; if we want persistence, add ?tab=... later.

import { useState } from "react"
import { Cpu, User as UserIcon, CircleAlert } from "lucide-react"
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
} from "@agent-harness/ui"
import { toast } from "sonner"
import { ProfilePage } from "./ProfilePage"
import { useConfig, useUpdateConfig } from "../hooks/queries"

type Tab = "profile" | "llm"

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
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton
          active={tab === "profile"}
          onClick={() => setTab("profile")}
          icon={<UserIcon className="size-4" />}
          label="Profile"
        />
        <TabButton
          active={tab === "llm"}
          onClick={() => setTab("llm")}
          icon={<Cpu className="size-4" />}
          label="LLM Config"
        />
      </div>

      {/* Tab body */}
      {tab === "profile" ? <ProfileTab /> : <LlmConfigTab />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {icon}
      {label}
    </button>
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
            Override the default model. Use any OpenAI-compatible endpoint.
            Leave <code className="font-mono">customProviderUrl</code> blank for
            the default gateway.
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
              <Input
                id="llmProvider"
                placeholder="e.g. openai"
                value={v("llmProvider")}
                onChange={e => set("llmProvider", e.target.value)}
                className="text-xs"
              />
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

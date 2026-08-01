import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Brain, User, Plus, Search, CircleAlert, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { api } from "../lib/api"
import type { UserMemory } from "@/types"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
} from "@agent-harness/ui"
import { toast } from "sonner"
import { useUserMemory } from "../hooks/queries"

// Normalize whatever the API returns for user-memory into {key,value} pairs.
// `updatedAt` is required on the UserMemory type but not always returned by
// the legacy object-shape endpoint; default to "" for those rows.
function toEntries(data: unknown): UserMemory[] {
  if (Array.isArray(data)) return data as UserMemory[]
  if (data && typeof data === "object") {
    if (Array.isArray((data as { entries?: unknown }).entries)) {
      return (data as { entries: UserMemory[] }).entries
    }
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      value: typeof v === "string" ? v : JSON.stringify(v),
      updatedAt: "",
    }))
  }
  return []
}

export function MemoryPage() {
  const qc = useQueryClient()
  // Refactored: previously this page re-implemented its own useQuery for
  // user-memory, bypassing the centralized useUserMemory() hook. Now uses
  // it directly so cache keys stay in lock-step with the rest of the app
  // (e.g. invalidations fired from other surfaces). The agent's own
  // context memory still goes through a raw useQuery — there's no
  // centralized useMemory() yet, but matching the same queryKey shape so
  // adding one later is a 1-line swap.
  const {
    data: memory,
    isError: userErr,
    error: userErrObj,
    refetch: refetchUser,
  } = useUserMemory()
  const {
    data: agentMemory,
    isError: agentErr,
    error: agentErrObj,
    refetch: refetchAgent,
  } = useQuery({
    queryKey: ["memory"],
    queryFn: () => api.get("/memory"),
  })

  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [search, setSearch] = useState("")

  const save = useMutation({
    mutationFn: () => api.put("/user-memory", { key, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-memory"] })
      setKey("")
      setValue("")
      toast.success("Memory entry saved")
    },
    onError: (e: { message?: string }) =>
      toast.error("Couldn't save memory", { description: e?.message }),
  })

  // Delete a user-authored memory entry by key. Backend: DELETE /api/user-memory/:key.
  const forgetUser = useMutation({
    mutationFn: (k: string) => api.del(`/user-memory/${encodeURIComponent(k)}`),
    onSuccess: (_data, k) => {
      qc.invalidateQueries({ queryKey: ["user-memory"] })
      toast.success(`Forgot "${k}"`)
    },
    onError: (e: { message?: string }) =>
      toast.error("Couldn't delete memory", { description: e?.message }),
  })

  // Delete an agent-learned memory entry by key. Backend: DELETE /api/memory/:key.
  const forgetAgent = useMutation({
    mutationFn: (k: string) => api.del(`/memory/${encodeURIComponent(k)}`),
    onSuccess: (_data, k) => {
      qc.invalidateQueries({ queryKey: ["memory"] })
      toast.success(`Forgot "${k}"`)
    },
    onError: (e: { message?: string }) =>
      toast.error("Couldn't delete memory", { description: e?.message }),
  })

  const rawEntries = useMemo(() => toEntries(memory), [memory])
  const agentEntries = useMemo<UserMemory[]>(
    () => (Array.isArray(agentMemory) ? (agentMemory as UserMemory[]) : []),
    [agentMemory],
  )

  const userEntries = useMemo(() => {
    if (!search) return rawEntries
    const q = search.toLowerCase()
    return rawEntries.filter(e => {
      const k = String(e.key ?? "").toLowerCase()
      const v = String(e.value ?? "").toLowerCase()
      return k.includes(q) || v.includes(q)
    })
  }, [rawEntries, search])

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Agent Memory Bank
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure preference constraints and view learned context stored in
            agent memory.
          </p>
        </div>
      </div>

      {/* Split Layout: Left Form & Right Store */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Add Memory & Search */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Plus className="size-4 text-primary" />
                Store New Memory Entry
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label
                  htmlFor="mem-key"
                  className="text-xs text-muted-foreground"
                >
                  Memory Key
                </Label>
                <Input
                  id="mem-key"
                  placeholder="e.g. preferred_stack"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="mem-value"
                  className="text-xs text-muted-foreground"
                >
                  Memory Value
                </Label>
                <Textarea
                  id="mem-value"
                  placeholder="e.g. TypeScript, React, Cloudflare Workers"
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  rows={3}
                  className="text-xs resize-y"
                />
              </div>

              <Button
                onClick={() => save.mutate()}
                disabled={!key || !value || save.isPending}
                className="w-full"
                size="sm"
              >
                {save.isPending ? "Saving entry…" : "Save Memory Entry"}
              </Button>
            </CardContent>
          </Card>

          {/* Search Filter */}
          <div className="relative">
            <Search className="size-3.5 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Search memory keys or values…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs bg-card"
            />
          </div>
        </div>

        {/* Right Column: Tabbed Memory Store Cards */}
        <div className="lg:col-span-2 space-y-6">
          {(userErr || agentErr) && (
            <Card className="border-destructive/40 bg-destructive/5 lg:col-span-3">
              <CardContent className="py-8 text-center">
                <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
                <p className="text-sm font-medium">Failed to load memory</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {(userErr ? userErrObj : agentErrObj) != null
                    ? (
                        (userErr ? userErrObj : agentErrObj) as {
                          message?: string
                        }
                      )?.message
                    : "Unknown error"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    if (userErr) refetchUser()
                    if (agentErr) refetchAgent()
                  }}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}

          {/* User Memory Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <User className="size-4 text-primary" />
                Your Defined Memories
              </h2>
              <Badge variant="secondary" className="font-mono text-xs">
                {userEntries.length} entries
              </Badge>
            </div>

            {userEntries.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-xl">
                No user memory entries found. Add a key-value pair using the
                form on the left.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {userEntries.map((e: UserMemory, i: number) => (
                  <Card
                    key={e.key ? `${e.key}-${i}` : i}
                    className="py-3 px-3.5 border-l-4 border-l-primary transition-all hover:border-primary group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="text-xs font-mono font-semibold text-primary break-all">
                        {e.key}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title={`Forget "${e.key}"`}
                        aria-label={`Forget memory entry ${e.key}`}
                        disabled={forgetUser.isPending}
                        onClick={() => forgetUser.mutate(e.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="text-xs text-foreground leading-relaxed">
                      {e.value}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Agent Learned Memory Section */}
          <div className="space-y-3 pt-4 border-t border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Brain className="size-4 text-violet-400" />
                Agent Learned Memories
              </h2>
              <Badge variant="secondary" className="font-mono text-xs">
                {agentEntries.length} entries
              </Badge>
            </div>

            {agentEntries.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-xl">
                The agent hasn't generated any learned memories yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {agentEntries.map((e: UserMemory, i: number) => (
                  <Card
                    key={e.key ? `${e.key}-${i}` : i}
                    className="py-3 px-3.5 border-l-4 border-l-violet-400/60 group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="text-xs font-mono font-semibold text-violet-400 break-all">
                        {e.key}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title={`Forget "${e.key}"`}
                        aria-label={`Forget agent memory ${e.key}`}
                        disabled={forgetAgent.isPending}
                        onClick={() => forgetAgent.mutate(e.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="text-xs text-foreground leading-relaxed">
                      {e.value}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

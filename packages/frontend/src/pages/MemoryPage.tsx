import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Brain, User, Plus, Search } from "lucide-react"
import { useState } from "react"
import { api } from "../lib/api"
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

export function MemoryPage() {
  const qc = useQueryClient()
  const { data: memory } = useQuery({
    queryKey: ["user-memory"],
    queryFn: () => api.get("/user-memory"),
  })
  const { data: agentMemory } = useQuery({
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
    onError: (e: any) => toast.error("Couldn't save memory", { description: e?.message }),
  })

  const rawEntries = Array.isArray(memory) ? memory : memory?.entries ?? Object.entries(memory ?? {})
  const agentEntries = agentMemory ?? []

  const userEntries = rawEntries.filter((e: any) => {
    if (!search) return true
    const q = search.toLowerCase()
    const k = String(e.key ?? e[0]).toLowerCase()
    const v = String(e.value ?? e[1]).toLowerCase()
    return k.includes(q) || v.includes(q)
  })

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Agent Memory Bank</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure preference constraints and view learned context stored in agent memory.
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
                <Label htmlFor="mem-key" className="text-xs text-muted-foreground">Memory Key</Label>
                <Input
                  id="mem-key"
                  placeholder="e.g. preferred_stack"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mem-value" className="text-xs text-muted-foreground">Memory Value</Label>
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
                No user memory entries found. Add a key-value pair using the form on the left.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {userEntries.map((e: any, i: number) => (
                  <Card
                    key={i}
                    className="py-3 px-3.5 border-l-4 border-l-primary transition-all hover:border-primary"
                  >
                    <div className="text-xs font-mono font-semibold text-primary mb-1">
                      {e.key ?? e[0]}
                    </div>
                    <div className="text-xs text-foreground leading-relaxed">
                      {e.value ?? e[1]}
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
                {agentEntries.map((e: any, i: number) => (
                  <Card
                    key={i}
                    className="py-3 px-3.5 border-l-4 border-l-violet-400/60"
                  >
                    <div className="text-xs font-mono font-semibold text-violet-400 mb-1">
                      {e.key ?? e[0]}
                    </div>
                    <div className="text-xs text-foreground leading-relaxed">
                      {e.value ?? e[1]}
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

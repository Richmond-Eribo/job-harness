import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../lib/api"
import { Button, Card, CardContent, Input, Label, Textarea } from "@agent-harness/ui"
import { toast } from "sonner"

export function MemoryPage() {
  const qc = useQueryClient()
  // Use the shared hooks for consistency with the rest of the app.
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

  const save = useMutation({
    mutationFn: () => api.put("/user-memory", { key, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-memory"] })
      setKey("")
      setValue("")
      toast.success("Memory saved")
    },
    onError: (e: any) => toast.error("Couldn't save memory", { description: e?.message }),
  })

  const entries = Array.isArray(memory) ? memory : memory?.entries ?? Object.entries(memory ?? {})

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Memory</h1>

      <Card className="mb-8">
        <CardHeaderLight title="Add a memory" />
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="mem-key" className="sr-only">Key</Label>
              <Input
                id="mem-key"
                placeholder="key"
                value={key}
                onChange={e => setKey(e.target.value)}
                className="w-36"
              />
            </div>
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="mem-value" className="sr-only">Value</Label>
              <Textarea
                id="mem-value"
                placeholder="value"
                value={value}
                onChange={e => setValue(e.target.value)}
                rows={1}
                className="min-h-9 resize-y"
              />
            </div>
            <Button onClick={() => save.mutate()} disabled={!key || !value || save.isPending} className="self-end">
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Your memories</h2>
          <div className="flex flex-col gap-2">
            {entries.length === 0 ? (
              <div className="text-xs text-muted-foreground">None yet.</div>
            ) : (
              entries.map((e: any, i: number) => (
                <Card key={i} className="py-3">
                  <CardContent className="px-3">
                    <div className="text-xs text-primary font-mono mb-1">{e.key ?? e[0]}</div>
                    <div className="text-sm text-foreground">{e.value ?? e[1]}</div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Agent memories</h2>
          <div className="flex flex-col gap-2">
            {(agentMemory ?? []).map((e: any, i: number) => (
              <Card key={i} className="py-3">
                <CardContent className="px-3">
                  <div className="text-xs text-primary font-mono mb-1">{e.key ?? e[0]}</div>
                  <div className="text-sm text-foreground">{e.value ?? e[1]}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Small helper so we don't repeat CardHeader boilerplate for a single title.
function CardHeaderLight({ title }: { title: string }) {
  return (
    <div className="px-4 pt-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
    </div>
  )
}

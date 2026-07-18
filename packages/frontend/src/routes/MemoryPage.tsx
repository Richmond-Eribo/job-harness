import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { useState } from "react"

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

  const save = useMutation({
    mutationFn: () => api.put("/user-memory", { key, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-memory"] })
      setKey("")
      setValue("")
    },
  })

  const entries = Array.isArray(memory) ? memory : memory?.entries ?? Object.entries(memory ?? {})

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Memory</h1>

      <div className="mb-8">
        <h2 className="text-sm font-semibold text-ink-300 mb-3">Add a memory</h2>
        <div className="flex gap-2 mb-3">
          <input
            placeholder="key"
            value={key}
            onChange={e => setKey(e.target.value)}
            className="px-3 py-2 rounded-lg bg-ink-900 border border-ink-800 text-white text-sm w-32 focus:outline-none focus:border-accent"
          />
          <input
            placeholder="value"
            value={value}
            onChange={e => setValue(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg bg-ink-900 border border-ink-800 text-white text-sm focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => save.mutate()}
            disabled={!key || !value}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-sm font-semibold text-ink-300 mb-3">Your memories</h2>
          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="text-xs text-ink-500">None yet.</div>
            ) : (
              entries.map((e: any, i: number) => (
                <div key={i} className="bg-ink-900 rounded-lg p-3 border border-ink-800">
                  <div className="text-xs text-accent font-mono mb-1">{e.key ?? e[0]}</div>
                  <div className="text-sm text-ink-300">{e.value ?? e[1]}</div>
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-ink-300 mb-3">Agent memories</h2>
          <div className="space-y-2">
            {(agentMemory ?? []).map((e: any, i: number) => (
              <div key={i} className="bg-ink-900 rounded-lg p-3 border border-ink-800">
                <div className="text-xs text-purple-400 font-mono mb-1">{e.key ?? e[0]}</div>
                <div className="text-sm text-ink-300">{e.value ?? e[1]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

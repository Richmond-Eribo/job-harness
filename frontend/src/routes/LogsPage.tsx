import { useLog } from "../hooks/queries"

export function LogsPage() {
  const { data, isLoading } = useLog()
  const logs = data ?? []

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Activity log</h1>
      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : logs.length === 0 ? (
        <div className="text-ink-500 text-sm py-8 text-center bg-ink-900 rounded-xl border border-ink-800">
          No activity yet.
        </div>
      ) : (
        <div className="bg-ink-900 rounded-xl border border-ink-800 divide-y divide-ink-800">
          {logs.map((l: any, i: number) => (
            <div key={i} className="px-4 py-3 flex items-start gap-4 text-sm">
              <span className="text-xs text-ink-700 font-mono mt-0.5 shrink-0">
                {l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : ""}
              </span>
              <span className="text-xs text-accent font-mono shrink-0 w-16">
                step {l.stepNumber ?? "—"}
              </span>
              <span className="text-ink-300 font-medium shrink-0">{l.action}</span>
              <span className="text-ink-500 truncate flex-1">{l.output ?? l.input ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

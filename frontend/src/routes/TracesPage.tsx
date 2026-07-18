import { Link } from "@tanstack/react-router"
import { useRuns } from "../hooks/queries"

export function TracesPage() {
  const { data, isLoading } = useRuns()
  const runs = data ?? []

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Traces</h1>
      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="text-ink-500 text-sm py-8 text-center bg-ink-900 rounded-xl border border-ink-800">
          No runs yet.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run: any) => (
            <Link
              key={run.runId}
              to="/traces/$runId"
              params={{ runId: run.runId }}
              className="block bg-ink-900 rounded-lg p-4 border border-ink-800 hover:border-ink-700 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-sm text-ink-300">{run.runId}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    run.status === "running"
                      ? "bg-emerald-950 text-emerald-400"
                      : run.status === "error"
                        ? "bg-red-950 text-red-400"
                        : "bg-ink-800 text-ink-400"
                  }`}
                >
                  {run.status}
                </span>
              </div>
              <div className="text-sm text-ink-500 truncate">{run.goal}</div>
              {run.startedAt && (
                <div className="text-xs text-ink-700 mt-1">
                  {new Date(run.startedAt).toLocaleString()}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

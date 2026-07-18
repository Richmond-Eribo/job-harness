import { useStatus, usePipeline, useStartRun, useStopRun } from "../hooks/queries"

const STAGES = [
  "discovered",
  "draft",
  "applied",
  "interview",
  "offer",
  "rejected",
] as const

export function OverviewPage() {
  const { data: status } = useStatus()
  const { data: pipeline } = usePipeline()
  const startRun = useStartRun()
  const stopRun = useStopRun()

  const isRunning = status?.status === "running"
  const stats = pipeline?.stats ?? {
    total: 0,
    byStatus: {} as Partial<Record<string, number>>,
    dueFollowUps: 0,
  }
  const listings = pipeline?.listings ?? []

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 text-sm ${
              isRunning ? "text-emerald-400" : "text-ink-500"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isRunning ? "bg-emerald-400 animate-pulse" : "bg-ink-700"
              }`}
            />
            {status?.status ?? "idle"}
          </span>
          {isRunning ? (
            <button
              onClick={() => stopRun.mutate()}
              className="px-4 py-2 rounded-lg bg-red-900 text-red-200 text-sm font-medium hover:bg-red-800"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => startRun.mutate(undefined)}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-600"
            >
              Start run
            </button>
          )}
        </div>
      </div>

      {/* Stage breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {STAGES.map(stage => (
          <div
            key={stage}
            className="bg-ink-900 rounded-xl p-4 border border-ink-800"
          >
            <div className="text-2xl font-bold">
              {stats.byStatus?.[stage] ?? 0}
            </div>
            <div className="text-xs text-ink-500 capitalize mt-0.5">{stage}</div>
          </div>
        ))}
      </div>

      {/* Recent jobs */}
      <h2 className="text-lg font-semibold mb-3">
        Recent jobs{" "}
        <span className="text-sm text-ink-500 font-normal">
          ({listings.length} total)
        </span>
      </h2>
      {listings.length === 0 ? (
        <div className="text-ink-500 text-sm py-8 text-center bg-ink-900 rounded-xl border border-ink-800">
          No jobs yet. Start a run to discover listings.
        </div>
      ) : (
        <div className="space-y-2">
          {listings.slice(0, 10).map((job: any) => (
            <div
              key={job.id}
              className="flex items-center gap-4 bg-ink-900 rounded-lg p-3 border border-ink-800 hover:border-ink-700"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{job.title}</div>
                <div className="text-sm text-ink-500 truncate">{job.company}</div>
              </div>
              <div className="text-xs text-ink-500 capitalize px-2 py-1 rounded bg-ink-800">
                {job.status}
              </div>
              {job.matchScore != null && (
                <div className="text-xs text-ink-500">
                  {(job.matchScore * 100).toFixed(0)}%
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

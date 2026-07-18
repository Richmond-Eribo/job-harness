import { Link } from "@tanstack/react-router"
import { useRuns } from "../hooks/queries"
import { Badge, Card, CardContent, Skeleton } from "@agent-harness/ui"

export function TracesPage() {
  const { data, isLoading } = useRuns()
  const runs = data ?? []

  const statusVariant = (s: string) =>
    s === "running" ? "default" : s === "error" ? "destructive" : "secondary"

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Traces</h1>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No runs yet.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {runs.map((run: any) => (
            <Link key={run.runId} to="/traces/$runId" params={{ runId: run.runId }}>
              <Card className="py-3 hover:border-primary/40 transition-colors">
                <CardContent className="px-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-sm text-muted-foreground">{run.runId}</span>
                    <Badge variant={statusVariant(run.status)} className="capitalize">{run.status}</Badge>
                  </div>
                  <div className="text-sm text-foreground truncate">{run.goal}</div>
                  {run.startedAt && (
                    <div className="text-xs text-muted-foreground/70 mt-1">
                      {new Date(run.startedAt).toLocaleString()}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

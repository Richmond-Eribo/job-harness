import { Link } from "@tanstack/react-router"
import { useRuns } from "../hooks/queries"
import type { RunSummary } from "../hooks/queries"
import { Badge, Button, Card, CardContent, Skeleton } from "@agent-harness/ui"
import { CircleAlert, Search } from "lucide-react"

export function TracesPage() {
  const { data, isLoading, isError, error, refetch } = useRuns()
  const runs = data ?? []

  const statusVariant = (s?: string) =>
    s === "running" ? "default" : s === "error" ? "destructive" : "secondary"

  // Left-border accent per status for at-a-glance scanning.
  const statusAccent = (s?: string) =>
    s === "running"
      ? "border-l-primary"
      : s === "error"
        ? "border-l-destructive"
        : s === "completed"
          ? "border-l-success"
          : "border-l-muted-foreground/30"

  return (
    <div className="p-8 max-w-4xl animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Traces</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Inspect every run the agent has performed.
        </p>
      </div>

      {isError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load runs</p>
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
      ) : isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Search className="size-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No runs yet. Start a run from the Overview page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {runs.map((run: RunSummary, i: number) => (
            <Link
              key={run.runId}
              to="/traces/$runId"
              params={{ runId: run.runId }}
            >
              <Card
                className={`py-3 border-l-2 ${statusAccent(run.status)} transition-all duration-150 hover:border-primary/30 hover:translate-x-0.5 animate-slide-up stagger-child`}
                style={{ "--stagger-i": i } as React.CSSProperties}
              >
                <CardContent className="px-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-sm text-foreground">
                      {run.runId}
                    </span>
                    <Badge
                      variant={statusVariant(run.status)}
                      className="capitalize"
                    >
                      {run.status}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {run.goal}
                  </div>
                  {run.startedAt && (
                    <div className="text-xs text-muted-foreground/60 font-mono mt-1.5">
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

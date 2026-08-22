import { useLog } from "../hooks/queries"
import type { StepLogEntry } from "@/types"
import { Button, Card, CardContent, Skeleton } from "@agent-harness/ui"
import { CircleAlert, ScrollText } from "lucide-react"

export function LogsPage() {
  const { data, isLoading, isError, error, refetch } = useLog()
  const logs = data ?? []

  return (
    <div className="p-8 max-w-4xl animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Activity log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A chronological record of every agent action.
        </p>
      </div>

      {isError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load activity log</p>
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
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <ScrollText className="size-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No activity yet. Logs appear once the agent runs.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {/* Column headers */}
            <div className="grid grid-cols-[5rem_4rem_minmax(7rem,auto)_1fr] items-center gap-3 px-4 py-2 border-b border-border bg-muted/40 text-[10px] text-muted-foreground/60 uppercase tracking-wider font-mono">
              <span>Time</span>
              <span>Step</span>
              <span>Action</span>
              <span>Detail</span>
            </div>

            {/* Log rows */}
            <div className="divide-y divide-border">
              {logs.map((l: StepLogEntry, i: number) => (
                <div
                  key={l.createdAt ? `${l.createdAt}-${l.stepNumber}-${i}` : i}
                  className={`px-4 py-2.5 grid grid-cols-[5rem_4rem_minmax(7rem,auto)_1fr] items-center gap-3 text-sm transition-colors hover:bg-accent/30 ${
                    i % 2 === 0 ? "" : "bg-muted/20"
                  }`}
                >
                  <span className="text-xs text-muted-foreground/70 font-mono tabular-nums">
                    {l.createdAt
                      ? new Date(l.createdAt).toLocaleTimeString()
                      : ""}
                  </span>
                  <span className="text-xs text-primary font-mono tabular-nums">
                    {l.stepNumber != null ? l.stepNumber : "—"}
                  </span>
                  <span className="text-foreground font-medium truncate">
                    {l.action}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {l.output ?? l.input ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

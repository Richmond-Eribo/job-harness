import { useLog } from "../hooks/queries"
import { Card, CardContent, Skeleton } from "@agent-harness/ui"

export function LogsPage() {
  const { data, isLoading } = useLog()
  const logs = data ?? []

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Activity log</h1>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No activity yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-border">
            {logs.map((l: any, i: number) => (
              <div key={i} className="px-4 py-3 flex items-start gap-4 text-sm">
                <span className="text-xs text-muted-foreground/70 font-mono mt-0.5 shrink-0 w-20">
                  {l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : ""}
                </span>
                <span className="text-xs text-primary font-mono shrink-0 w-16">
                  step {l.stepNumber ?? "—"}
                </span>
                <span className="text-foreground font-medium shrink-0">{l.action}</span>
                <span className="text-muted-foreground truncate flex-1 font-mono">
                  {l.output ?? l.input ?? ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

import * as React from "react"

import { cn } from "../lib/utils"

/**
 * Accessible progress bar (labeled use stays the caller's job per §10.2 —
 * always pair with a visible text value for match scores). Plain divs, no
 * Radix dependency; the indicator color is overridable for status accents.
 */
function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<"div"> & {
  /** 0–100; out-of-range values are clamped. */
  value?: number
  /** Extra classes for the filled indicator (e.g. bg-success). */
  indicatorClassName?: string
}) {
  const clamped = Math.min(100, Math.max(0, value ?? 0))

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full bg-primary transition-all duration-300",
          indicatorClassName
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export { Progress }

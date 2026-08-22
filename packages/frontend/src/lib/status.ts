// =============================================================================
// Pipeline status metadata — the single source of truth for how each
// JobStatus is rendered anywhere in the UI (kanban columns + cards, Overview
// stat cards, badges, the job detail header).
//
// Color semantics follow docs/PROJECT_PLAN.md §10.2:
//   Discovered = muted blue · Draft = primary blue · Applied = warning amber
//   Interview = violet #7C3AED · Offer = success green · Rejected = red
// Tinted-badge text uses the -700 step of each hue (not the raw accent hex)
// so small badge text keeps ≥4.5:1 contrast on the tinted fill. Status is
// ALWAYS paired with its text label — never color alone.
// =============================================================================

import type { JobStatus } from "@/types"

export interface StatusMeta {
  /** Human label, e.g. "Cover letter drafted". */
  label: string
  /** Tinted fill + colored text badge classes (border included). */
  badgeClass: string
  /** Solid dot (status pills, kanban column headers). */
  dotClass: string
  /** Left/top accent bar for cards & columns. */
  accentClass: string
  /** Valid forward transitions from this status. */
  next: JobStatus[]
}

/** Kanban column order (matches getPipeline SQL ordering). */
export const STATUS_ORDER: JobStatus[] = [
  "discovered",
  "draft",
  "applied",
  "interview",
  "offer",
  "rejected",
]

export const STATUS_META: Record<JobStatus, StatusMeta> = {
  discovered: {
    label: "Discovered",
    badgeClass:
      "bg-primary/10 text-blue-700 border border-primary/20",
    dotClass: "bg-primary/50",
    accentClass: "border-t-primary/40",
    next: ["draft", "rejected"],
  },
  draft: {
    label: "Draft",
    badgeClass: "bg-primary text-white border border-primary",
    dotClass: "bg-primary",
    accentClass: "border-t-primary",
    next: ["applied", "rejected"],
  },
  applied: {
    label: "Applied",
    badgeClass:
      "bg-warning/10 text-amber-700 border border-warning/25",
    dotClass: "bg-warning",
    accentClass: "border-t-warning",
    next: ["interview", "rejected"],
  },
  interview: {
    label: "Interview",
    badgeClass:
      "bg-interview/10 text-violet-700 border border-interview/25",
    dotClass: "bg-interview",
    accentClass: "border-t-interview",
    next: ["offer", "rejected"],
  },
  offer: {
    label: "Offer",
    badgeClass:
      "bg-success/10 text-emerald-700 border border-success/25",
    dotClass: "bg-success",
    accentClass: "border-t-success",
    next: [],
  },
  rejected: {
    label: "Rejected",
    badgeClass:
      "bg-destructive/10 text-red-700 border border-destructive/20",
    dotClass: "bg-destructive",
    accentClass: "border-t-destructive/60",
    next: [],
  },
}

/** The single "Advance →" target from a status (null when terminal). */
export function nextStatus(status: JobStatus): JobStatus | null {
  const next = STATUS_META[status].next
  return next.includes("rejected")
    ? next[0]
    : (next[0] ?? null)
}

/** Is `to` a legal transition from `from`? (Forward moves + un-reject.) */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false
  // Allow moving a rejected job back into the funnel — people reopen
  // applications — but the forward path itself stays linear.
  if (from === "rejected") return to !== "rejected"
  return STATUS_META[from].next.includes(to)
}

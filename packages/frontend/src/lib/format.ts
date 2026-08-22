// =============================================================================
// Small formatting helpers shared across pages.
// =============================================================================

/**
 * Relative time ("3h ago", "2d ago"). Backend timestamps come from SQLite
 * datetime('now') — "YYYY-MM-DD HH:MM:SS" in UTC, no T/Z — so normalize to
 * ISO before parsing; otherwise browsers disagree on the format.
 */
export function formatRelative(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const normalized = dateStr.includes("T")
    ? dateStr
    : dateStr.replace(" ", "T") + "Z"
  const then = new Date(normalized).getTime()
  if (Number.isNaN(then)) return ""

  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/** Absolute "Jan 5, 2027, 14:30" for detail views. */
export function formatAbsolute(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const normalized = dateStr.includes("T")
    ? dateStr
    : dateStr.replace(" ", "T") + "Z"
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

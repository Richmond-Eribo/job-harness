// =============================================================================
// Schedule (stored in SQLite, managed from dashboard)
// =============================================================================

export interface ScheduleEntry {
  id: number
  cron: string
  focus: "all" | "research" | "jobs"
  enabled: boolean
  lastTriggeredAt: string | null
  // Derived (not stored): human-readable description + next fire time in UTC.
  // null when the cron expression is invalid (kept for forward-compat with rows
  // created before server-side validation was added).
  description: string | null
  nextFireAt: string | null
}

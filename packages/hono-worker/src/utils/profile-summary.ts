// =============================================================================
// profile-summary — render the per-user profile for LLM prompts.
// =============================================================================
// Single source of truth for how a user's profile enters ANY prompt (harness
// system prompt, goal synthesis, planner, job search, cover letters). Only
// fields meaningful to the model are emitted — internal CV pointer metadata
// (cv, cvR2Key, cvFilename, cvContentType, cvUploadedAt) is noise and never
// included. Multi-tenant by construction: callers pass the profile fetched
// from the owning user's JobApplicationAgent DO.
// =============================================================================
import type { UserProfile } from "@agent-harness/shared-types"

/** Ordered (key → label) pairs for prompt rendering. CV pointer keys are
 *  deliberately absent — see the header comment. */
const FIELD_LABELS: Array<[keyof UserProfile, string]> = [
  ["fullName", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["location", "Location"],
  ["seniority", "Seniority"],
  ["yearsExperience", "Years of experience"],
  ["workAuth", "Work authorization"],
  ["workMode", "Work mode"],
  ["jobSearchStatus", "Job search status"],
  ["targetRoles", "Target roles"],
  ["targetLocations", "Target locations"],
  ["skills", "Skills"],
  ["preferences", "Preferences"],
  ["linkedinUrl", "LinkedIn"],
  ["githubUrl", "GitHub"],
  ["portfolioUrl", "Portfolio"],
]

export interface ProfileFormatOptions {
  /** Append an excerpt of the parsed CV text. Off by default — search-style
   *  prompts only need the structured fields; document-drafting prompts
   *  (cover letters) want the real experience to ground against. */
  includeCvText?: boolean
  /** Character cap for the CV excerpt. Default 4_000 (~1k tokens). */
  cvExcerptChars?: number
}

/** Render the profile as labeled lines for a prompt block. */
export function formatProfileForPrompt(
  profile: UserProfile | null | undefined,
  opts: ProfileFormatOptions = {},
): string {
  const lines: string[] = []
  for (const [key, label] of FIELD_LABELS) {
    const value = profile?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      lines.push(`${label}: ${value.trim()}`)
    }
  }

  if (opts.includeCvText) {
    const cvText = profile?.cvText
    if (typeof cvText === "string" && cvText.trim().length > 0) {
      const cap = opts.cvExcerptChars ?? 4_000
      const text = cvText.trim()
      lines.push(
        text.length > cap
          ? `CV excerpt (from the uploaded CV, truncated):\n${text.slice(0, cap)}\n…(truncated)`
          : `CV text (from the uploaded CV):\n${text}`,
      )
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no profile set yet)"
}

/**
 * Deterministic default run goal derived from the user's own target roles,
 * locations, and work mode — used when no explicit goal is set. Replaces the
 * old hardcoded "software / AI engineering" fallback that steered every
 * tenant toward tech roles regardless of their CV.
 */
export function deriveDefaultGoal(profile: UserProfile | null | undefined): string {
  const roles = profile?.targetRoles?.trim()
  const locations = profile?.targetLocations?.trim()
  const workMode = profile?.workMode?.trim()

  const parts = [
    "Discover, rank, and apply to",
    roles ? `${roles} roles` : "roles that match the candidate profile",
  ]
  if (locations) parts.push(`in ${locations}`)
  let goal = parts.join(" ")
  if (workMode) goal += ` (${workMode})`
  return goal
}

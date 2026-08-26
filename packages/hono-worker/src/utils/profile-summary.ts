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
 * The deterministic STANDING goal — the user's job-search mission, derived
 * from their own target roles / locations / work mode when they haven't set
 * one explicitly. This is the goal scheduled (cron) runs and dashboard runs
 * execute; one-off runs ("Apply with agent") carry their own goal and never
 * replace it.
 *
 * Written as a functional mission over the real pipeline flow (check →
 * discover → draft → assist-apply → maintain) so the agent always works the
 * user's aim end to end. Keep in sync conceptually with default.md (the
 * playbook covers HOW; this states WHAT and WHY).
 */
export function deriveDefaultGoal(
  profile: UserProfile | null | undefined,
): string {
  const roles = profile?.targetRoles?.trim()
  const locations = profile?.targetLocations?.trim()
  const workMode = profile?.workMode?.trim()

  const roleLine = roles
    ? `find REAL ${roles} roles`
    : "find REAL roles that match the candidate profile"
  const locationLine = locations ? ` in ${locations}` : ""
  const modeLine = workMode ? ` (${workMode})` : ""

  return [
    "Run my job search end to end as a continuous pipeline, working autonomously each run:",
    "",
    "1. Check the pipeline first (pipeline_status): keep discovering only while fewer than ~10 jobs are in `discovered`; otherwise go straight to drafting.",
    `2. DISCOVER — ${roleLine}${locationLine}${modeLine}: use discover_jobs for scrapable boards and the paired browser for login-walled sites. Score fit for every listing; save only postings you actually opened.`,
    "3. DRAFT — for the strongest matches, generate a grounded tailored CV + cover letter (write_tailored_cv, write_cover_letter) and move each job to `draft` for my review. Never fabricate experience.",
    "4. APPLY — assist my applications: open the posting in my paired browser and fill TEXT fields from my profile and document contents. Never submit and never log in yourself. You CANNOT upload or attach files (no file-picker capability) — leave every file-upload field for me and list what still needs uploading. Mark the job `applied` once the form is otherwise ready for my one-click submit.",
    "5. MAINTAIN — keep job statuses and follow-ups current, respect my operator notes, persist what works and what dead-ends with `remember`, and end every run with a concrete `finish` summary: progress made, pending uploads, and the single most valuable next action.",
    "",
    "Ground rules: never invent companies, titles, or URLs — every fact comes from a tool or a page you opened; prefer fewer verified actions over many speculative ones.",
  ].join("\n")
}

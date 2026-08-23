// -----------------------------------------------------------------------------
// profile-summary — the per-user context that steers the whole agent.
// -----------------------------------------------------------------------------
// These guards exist because the agent used to run with hardcoded assumptions
// (a default "software / AI engineering" goal, biased search examples) instead
// of the user's own CV/profile. The contracts tested here are the fix:
//   • every prompt block renders ONLY from the user's profile data
//   • internal CV pointer metadata never leaks into a prompt
//   • the default goal derives from the user's target roles/locations/work mode
// -----------------------------------------------------------------------------
import { describe, it, expect } from "vitest"
import type { UserProfile } from "@agent-harness/shared-types"
import {
  formatProfileForPrompt,
  deriveDefaultGoal,
} from "../utils/profile-summary"
import { buildSystemPrompt } from "../agents/prompt"
import type { SqlAgent } from "../db/db"

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    firstName: null,
    lastName: null,
    fullName: null,
    email: null,
    phone: null,
    location: null,
    links: null,
    workAuth: null,
    seniority: null,
    yearsExperience: null,
    targetRoles: null,
    targetLocations: null,
    skills: null,
    preferences: null,
    workMode: null,
    jobSearchStatus: null,
    linkedinUrl: null,
    githubUrl: null,
    portfolioUrl: null,
    cv: null,
    cvFilename: null,
    cvContentType: null,
    cvR2Key: null,
    cvUploadedAt: null,
    cvText: null,
    ...overrides,
  }
}

describe("formatProfileForPrompt", () => {
  it("renders set fields with readable labels", () => {
    const out = formatProfileForPrompt(
      profile({
        fullName: "Ada Lovelace",
        targetRoles: "Data Engineer",
        targetLocations: "Lagos, Nigeria",
        workMode: "remote",
      }),
    )
    expect(out).toContain("Name: Ada Lovelace")
    expect(out).toContain("Target roles: Data Engineer")
    expect(out).toContain("Target locations: Lagos, Nigeria")
    expect(out).toContain("Work mode: remote")
  })

  it("skips null and whitespace-only fields", () => {
    const out = formatProfileForPrompt(
      profile({ seniority: null, skills: "   ", location: "Berlin" }),
    )
    expect(out).toContain("Location: Berlin")
    expect(out).not.toContain("Seniority")
    expect(out).not.toContain("Skills")
  })

  it("never leaks internal CV pointer metadata", () => {
    const out = formatProfileForPrompt(
      profile({
        cv: JSON.stringify({
          r2Key: "cvs/user-1/secret-uuid",
          filename: "cv.pdf",
        }),
        cvR2Key: "cvs/user-1/secret-uuid",
        cvFilename: "cv.pdf",
        cvContentType: "application/pdf",
        cvUploadedAt: "2026-01-01T00:00:00Z",
      }),
    )
    expect(out).not.toContain("cvs/user-1/secret-uuid")
    expect(out).not.toContain("cv.pdf")
    expect(out).not.toContain("application/pdf")
    expect(out).not.toContain("cvUploadedAt")
    expect(out).not.toContain("cvR2Key")
  })

  it("omits CV text by default (search-style prompts)", () => {
    const out = formatProfileForPrompt(
      profile({ cvText: " ten years building pipelines " }),
    )
    expect(out).not.toContain("pipelines")
  })

  it("includes a capped CV excerpt when asked", () => {
    const longCv = "A".repeat(10_000)
    const out = formatProfileForPrompt(
      profile({ cvText: longCv, targetRoles: "Data Engineer" }),
      { includeCvText: true, cvExcerptChars: 4_000 },
    )
    expect(out).toContain("CV excerpt")
    expect(out).toContain("(truncated)")
    // The excerpt must be bounded, not the whole 10k blob.
    expect(out.indexOf("A".repeat(4_001))).toBe(-1)
  })

  it("includes the full CV when it fits under the cap", () => {
    const out = formatProfileForPrompt(
      profile({ cvText: "Short but real experience" }),
      { includeCvText: true },
    )
    expect(out).toContain("Short but real experience")
    expect(out).not.toContain("(truncated)")
  })

  it("returns the fallback for an empty profile", () => {
    expect(formatProfileForPrompt(profile())).toBe("(no profile set yet)")
    expect(formatProfileForPrompt(null)).toBe("(no profile set yet)")
  })
})

describe("deriveDefaultGoal", () => {
  it("builds the goal from the user's own roles, locations, and work mode", () => {
    expect(
      deriveDefaultGoal(
        profile({
          targetRoles: "Product Manager",
          targetLocations: "Nairobi",
          workMode: "hybrid",
        }),
      ),
    ).toBe(
      "Discover, rank, and apply to Product Manager roles in Nairobi (hybrid)",
    )
  })

  it("works with roles only", () => {
    expect(deriveDefaultGoal(profile({ targetRoles: "Nurse" }))).toBe(
      "Discover, rank, and apply to Nurse roles",
    )
  })

  it("falls back to a profile-relative goal when nothing is set", () => {
    expect(deriveDefaultGoal(profile())).toBe(
      "Discover, rank, and apply to roles that match the candidate profile",
    )
    expect(deriveDefaultGoal(null)).toBe(
      "Discover, rank, and apply to roles that match the candidate profile",
    )
  })

  it("contains no hardcoded occupation bias", () => {
    for (const p of [
      profile(),
      profile({ targetRoles: "Chef" }),
      profile({ workMode: "onsite" }),
    ]) {
      const goal = deriveDefaultGoal(p)
      expect(goal.toLowerCase()).not.toContain("software")
      expect(goal.toLowerCase()).not.toContain("ai engineering")
      expect(goal.toLowerCase()).not.toContain("engineer")
    }
  })
})

// Minimal SqlAgent: every table read returns no rows, which the prompt
// builders handle with their documented fallbacks.
const emptyAgent: SqlAgent = { sql: () => [] }

describe("buildSystemPrompt candidate layer", () => {
  const prompt = buildSystemPrompt(
    emptyAgent,
    "run-test",
    "Discover, rank, and apply to Data Engineer roles",
    100,
    128000,
    null,
    "Name: Ada Lovelace\nTarget roles: Data Engineer",
  )

  it("includes the candidate profile section with its grounding rule", () => {
    expect(prompt).toContain("# The candidate you work for")
    expect(prompt).toContain(
      "Every search criterion you write, match score you assign, and application decision you make MUST be grounded in this profile",
    )
    expect(prompt).toContain("Name: Ada Lovelace")
    expect(prompt).toContain("Target roles: Data Engineer")
  })

  it("places the candidate ABOVE the operator notes and live context", () => {
    const candidateAt = prompt.indexOf("# The candidate you work for")
    const notesAt = prompt.indexOf("# Notes from the operator")
    const goalAt = prompt.indexOf("# Goal")
    expect(candidateAt).toBeGreaterThan(-1)
    expect(candidateAt).toBeLessThan(notesAt)
    expect(notesAt).toBeLessThan(goalAt)
  })

  it("does not duplicate the profile into the goal block", () => {
    const goalBlock = prompt.slice(
      prompt.indexOf("# Goal"),
      prompt.indexOf("# Today"),
    )
    expect(goalBlock).not.toContain("Ada Lovelace")
  })
})

import { Agent, callable } from "agents"
import { generateText } from "ai"
import { getModel, getParams } from "../llm"
import type {
  Env,
  JobListing,
  JobStatus,
  CoverLetter,
  FollowUp,
  UserProfile,
  JobSearchRequest,
  JobSearchResponse,
  CoverLetterRequest,
  CoverLetterResponse,
} from "../types"
import { TraceRecorder } from "../utils/trace-recorder"
import obsConfig from "../config/observability-config.json"

// =============================================================================
// Database initialization
// =============================================================================

// Database access goes through the shared `execSql` helper in ./db.
// It takes the AGENT instance (not a detached `this.sql`) so the SDK's `sql`
// getter keeps its `this` binding, and converts each `?` into one real bound
// parameter. See ./db.ts for the full rationale.
import { execSql } from "../db/db"
import type { SqlAgent } from "../db/db"

function initDb(agent: SqlAgent) {
  // NOTE: The Agent SDK's sql tagged template executes ONE statement per call.
  // Multi-statement strings are not supported, so each CREATE TABLE is separate.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS user_profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS job_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT,
      match_score REAL,
      status TEXT DEFAULT 'discovered',
      priority INTEGER DEFAULT 5,
      notes TEXT,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS cover_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES job_listings(id),
      version INTEGER DEFAULT 1,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES job_listings(id),
      due_date TEXT NOT NULL,
      note TEXT,
      completed INTEGER DEFAULT 0
    )`,
  )
}

// =============================================================================
// Helper: get user profile as a string
// =============================================================================

function getProfileString(agent: SqlAgent): string {
  const rows = execSql(agent, `SELECT key, value FROM user_profile`)

  if (rows.length === 0) return "No profile set yet."

  return rows.map((r: any) => `${r.key}: ${r.value}`).join("\n\n")
}

// =============================================================================
// Real job-listing discovery (no API keys)
// =============================================================================
// These fetch from PUBLIC, key-less job board APIs over HTTPS and return
// normalized raw listings. They are the ground truth the searchJobs() pipeline
// draws from — the LLM is NEVER allowed to invent a listing; it only ranks and
// scores the listings these functions actually returned. (Anthropic: agents
// must "gain ground truth from the environment" — invented URLs are not truth.)
//
// Multiple sources are fan-out'd in parallel; each is wrapped in try/catch so a
// single failing provider degrades gracefully instead of failing the run.
// =============================================================================

interface RawJobListing {
  company: string
  title: string
  description: string
  url: string
  location: string
  tags: string[]
  source: string // which board it came from
}

// --- Arbeitnow (https://www.arbeitnow.com/api/job-board-api) ---
// Free, no key, CORS-friendly, JSON. Powers many open job boards.
async function fetchArbeitnow(maxResults: number): Promise<RawJobListing[]> {
  const res = await fetch("https://www.arbeitnow.com/api/job-board-api", {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Arbeitnow ${res.status}`)
  const data: any = await res.json()
  const jobs: any[] = Array.isArray(data?.data) ? data.data : []
  return jobs.slice(0, maxResults).map(j => ({
    company: j.company_name ?? j.company ?? "Unknown",
    title: j.title ?? "Untitled role",
    description: j.description ?? "",
    url: j.url ?? j.slug ?? "",
    location:
      [j.location, j.remote ? "Remote" : null].filter(Boolean).join(", ") ||
      "Unspecified",
    tags: Array.isArray(j.tags) ? j.tags : [],
    source: "arbeitnow",
  }))
}

// --- Remotive (https://remotive.com/api/remote-jobs) ---
// Free, no key, JSON. Remote-only roles, strong in tech.
async function fetchRemotive(
  query: string,
  maxResults: number,
): Promise<RawJobListing[]> {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${maxResults}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Remotive ${res.status}`)
  const data: any = await res.json()
  const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : []
  return jobs.slice(0, maxResults).map(j => ({
    company: j.company_name ?? "Unknown",
    title: j.title ?? "Untitled role",
    description: j.description ?? "",
    url: j.url ?? "",
    location: j.candidate_required_location ?? "Remote",
    tags: Array.isArray(j.tags) ? j.tags : [],
    source: "remotive",
  }))
}

// Fan out across all sources; never throw on a single failure.
async function fetchJobListings(
  query: string,
  maxResults: number,
): Promise<RawJobListing[]> {
  const perSource = Math.min(maxResults * 4, 40) // over-fetch, filter down later
  const settled = await Promise.allSettled([
    fetchRemotive(query, perSource),
    fetchArbeitnow(perSource),
  ])

  const all: RawJobListing[] = []
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value)
  }
  return all
}

// =============================================================================
// JobApplicationAgent class
// =============================================================================

interface JobAgentState {
  initialized: boolean
}

export class JobApplicationAgent extends Agent<Env, JobAgentState> {
  initialState: JobAgentState = { initialized: false }

  private ensureDb() {
    if (!this.state.initialized) {
      initDb(this)
      this.setState({ ...this.state, initialized: true })
    }
  }

  // ---------------------------------------------------------------------------
  // Profile management
  // ---------------------------------------------------------------------------

  @callable()
  async setProfile(profile: Partial<UserProfile>): Promise<string> {
    this.ensureDb()

    const entries = Object.entries(profile).filter(
      ([_, v]) => v !== null && v !== undefined,
    )

    for (const [key, value] of entries) {
      execSql(
        this,
        `INSERT INTO user_profile (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
        [key, value, value],
      )
    }

    return `Profile updated: ${entries.map(([k]) => k).join(", ")}`
  }

  @callable()
  async getProfile(): Promise<UserProfile> {
    this.ensureDb()

    const rows = execSql(this, `SELECT key, value FROM user_profile`)

    const profile: Record<string, string | null> = {
      cv: null,
      preferences: null,
      targetRoles: null,
      targetLocations: null,
      skills: null,
    }

    for (const row of rows) {
      profile[row.key as string] = row.value as string
    }

    return profile as unknown as UserProfile
  }

  // ---------------------------------------------------------------------------
  // Job search (autonomous discovery)
  // ---------------------------------------------------------------------------

  @callable()
  async searchJobs(request: JobSearchRequest): Promise<JobSearchResponse> {
    this.ensureDb()

    const profileStr = getProfileString(this)
    const maxResults = request.maxResults ?? 5
    const criteria = request.criteria

    // ---- Step 1: FETCH real listings (no LLM here, no fabrication possible) ----
    const raw = await fetchJobListings(criteria, maxResults)

    if (raw.length === 0) {
      return {
        newListings: [],
        pipelineUpdate: this.getPipelineStats(),
      }
    }

    // ---- Step 2: LLM ranks + scores the REAL listings (NO tools, no save_job) ----
    // generateObject would be ideal, but to keep deps light we ask for strict
    // JSON and parse defensively. The model only sees listings we already have;
    // it CANNOT add new ones — every ranked item must reference an idx.
    const prompt = `You are ranking real job listings against a candidate's profile.

CANDIDATE PROFILE:
${profileStr}

SEARCH CRITERIA: "${criteria}"

Below are ${raw.length} ACTUAL listings fetched from job boards. Score each one 0.0–1.0 for fit
(candidate profile vs role). Only include listings you'd score >= 0.4. Return STRICT JSON, no prose:
{"ranked":[{"idx":0,"matchScore":0.82,"reason":"one line why"}, ...]}

LISTINGS:
${raw
  .map(
    (r, i) =>
      `[${i}] ${r.title} @ ${r.company} (${r.location})\n    tags: ${r.tags.join(", ") || "n/a"}\n    ${r.description.slice(0, 280).replace(/\s+/g, " ")}…\n    url: ${r.url}`,
  )
  .join("\n\n")}`

    let ranked: Array<{ idx: number; matchScore: number; reason: string }> = []
    try {
      const model = getModel(this.env)
      const result = await generateText({
        model,
        system:
          "You score job listings for fit. You never invent listings — you only return idx values that reference the provided list, with a matchScore in [0,1]. Output is JSON only.",
        prompt,
        ...getParams(this.env),
      })

      const text = result.text.trim()
      // Tolerate accidental markdown fences / prose around the JSON object.
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end !== -1 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1))
        ranked = Array.isArray(parsed?.ranked) ? parsed.ranked : []
      }
    } catch {
      // Ranking failed (model/API error). Fall back to a CHEAP keyword-overlap
      // score so we don't blindly dump 40 listings into the pipeline. Only
      // listings whose title/tags/description overlap the criteria get saved.
      const criteriaTokens = criteria
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter(t => t.length > 2)
      ranked = raw.map((listing, idx) => {
        const hay =
          `${listing.title} ${listing.company} ${listing.tags.join(" ")} ${listing.description}`.toLowerCase()
        const hits = criteriaTokens.filter(t => hay.includes(t)).length
        const score =
          criteriaTokens.length > 0 ? hits / criteriaTokens.length : 0.3
        return {
          idx,
          matchScore: Math.min(score, 1),
          reason: "auto: keyword overlap",
        }
      })
    }

    // ---- Step 3: filter + persist, preserving only entries that map to a real listing ----
    const savedThisRun: JobSearchResponse["newListings"] = []
    for (const r of ranked) {
      const listing = raw[r.idx]
      if (!listing) continue // phantom idx — ignore, never invent
      if (typeof r.matchScore !== "number" || r.matchScore < 0.4) continue

      // Dedupe by URL or company+title
      const existing = execSql(
        this,
        `SELECT id FROM job_listings
           WHERE (url = ? AND url IS NOT NULL AND url <> '')
              OR (company = ? AND title = ?)
           LIMIT 1`,
        [listing.url, listing.company, listing.title],
      )
      if (existing.length > 0) continue

      execSql(
        this,
        `INSERT INTO job_listings (company, title, description, url, match_score, source, notes)
         VALUES (?, ?, ?, ?, ?, 'auto-discovered', ?)`,
        [
          listing.company,
          listing.title,
          listing.description.slice(0, 8000),
          listing.url,
          r.matchScore,
          `via ${listing.source}${r.reason ? ` — ${r.reason}` : ""}`,
        ],
      )

      savedThisRun.push({
        company: listing.company,
        title: listing.title,
        description: listing.description.slice(0, 2000),
        url: listing.url,
        matchScore: r.matchScore,
      })
      if (savedThisRun.length >= maxResults) break
    }

    return {
      newListings: savedThisRun,
      pipelineUpdate: this.getPipelineStats(),
    }
  }

  // ---------------------------------------------------------------------------
  // Manual job management
  // ---------------------------------------------------------------------------

  @callable()
  async addJob(job: {
    company: string
    title: string
    description?: string
    url?: string
  }): Promise<{ id: number; message: string }> {
    this.ensureDb()

    execSql(
      this,
      `INSERT INTO job_listings (company, title, description, url, source)
       VALUES (?, ?, ?, ?, 'manual')`,
      [job.company, job.title, job.description ?? null, job.url ?? null],
    )

    const row = execSql(this, `SELECT last_insert_rowid() as id`)[0] as any

    return { id: row.id, message: `Added: ${job.title} at ${job.company}` }
  }

  // ---------------------------------------------------------------------------
  // Cover letter generation
  // ---------------------------------------------------------------------------

  @callable()
  async generateCoverLetter(
    request: CoverLetterRequest,
  ): Promise<CoverLetterResponse> {
    this.ensureDb()

    const model = getModel(this.env)
    const profileStr = getProfileString(this)

    // Get the job listing
    const jobs = execSql(this, `SELECT * FROM job_listings WHERE id = ?`, [
      request.jobId,
    ])

    if (jobs.length === 0) {
      throw new Error(`Job listing not found: ${request.jobId}`)
    }

    const job = jobs[0] as any

    // Get existing cover letters for version tracking
    const existingLetters = execSql(
      this,
      `SELECT MAX(version) as max_version FROM cover_letters WHERE job_id = ?`,
      [request.jobId],
    )

    const nextVersion = ((existingLetters[0] as any)?.max_version ?? 0) + 1

    // ── Trace recorder (buffer + return) ────────────────────────────────
    const runId = request.runId ?? "cover-letter-standalone"
    const recorder = new TraceRecorder({
      agent: "job-agent",
      runId,
      redactKeys: obsConfig.logging?.redactToolArgs ?? [],
    })
    recorder.recordRunStart(
      `cover letter: ${job.company} / ${job.title}`,
      1,
      0,
    )

    // Generate cover letter
    const systemPrompt = `You are an expert cover letter writer. Generate a compelling, tailored cover letter.

User Profile:
${profileStr}

Rules:
- Tailor the letter specifically to this role and company
- Highlight relevant skills and experience from the profile
- Be professional but personable — avoid generic templates
- Keep it concise (3-4 paragraphs)
- Address specific requirements from the job description
- Show genuine interest in the company and role`
    const userPrompt = `Write a cover letter for this position:

Company: ${job.company}
Title: ${job.title}
Description: ${job.description ?? "Not provided"}
URL: ${job.url ?? "Not provided"}

Generate a tailored, compelling cover letter.`

    recorder.recordSystem("system-prompt", systemPrompt)
    recorder.recordPrompt(0, [{ role: "user", content: userPrompt }])

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      ...getParams(this.env),
      ...recorder.attach(),
    })
    recorder.flushFallback(null, Date.now(), {
      usage: result.usage,
      steps: result.steps,
      response: result.response,
      finishReason: result.finishReason,
      warnings: result.warnings,
    })

    // Save cover letter
    execSql(
      this,
      `INSERT INTO cover_letters (job_id, version, content) VALUES (?, ?, ?)`,
      [request.jobId, nextVersion, result.text],
    )

    // Update job status to 'draft' if it was 'discovered'
    execSql(
      this,
      `UPDATE job_listings SET status = 'draft', updated_at = datetime('now')
       WHERE id = ? AND status = 'discovered'`,
      [request.jobId],
    )

    return {
      jobId: request.jobId,
      company: job.company,
      title: job.title,
      coverLetter: result.text,
      version: nextVersion,
      // Sub-agent inner-loop trace — nested under the write_cover_letter call.
      __trace: recorder.toSubAgentTrace(),
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline management
  // ---------------------------------------------------------------------------

  @callable()
  async getJob(jobId: number): Promise<{
    listing: JobListing | null
    coverLetters: CoverLetter[]
    followUps: FollowUp[]
  }> {
    this.ensureDb()
    const jobRows = execSql(this, `SELECT * FROM job_listings WHERE id = ?`, [
      jobId,
    ])
    const listing: JobListing | null =
      jobRows.length > 0
        ? (() => {
            const r = jobRows[0] as any
            return {
              id: r.id,
              company: r.company,
              title: r.title,
              description: r.description,
              url: r.url,
              matchScore: r.match_score,
              status: r.status,
              priority: r.priority,
              notes: r.notes,
              source: r.source,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            } as JobListing
          })()
        : null

    const clRows = execSql(
      this,
      `SELECT * FROM cover_letters WHERE job_id = ? ORDER BY version DESC`,
      [jobId],
    )
    const coverLetters: CoverLetter[] = clRows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      version: r.version,
      content: r.content,
      createdAt: r.created_at,
    }))

    const fuRows = execSql(
      this,
      `SELECT * FROM follow_ups WHERE job_id = ? ORDER BY due_date ASC`,
      [jobId],
    )
    const followUps: FollowUp[] = fuRows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      dueDate: r.due_date,
      note: r.note,
      completed: r.completed === 1,
    }))

    return { listing, coverLetters, followUps }
  }

  @callable()
  async updateStatus(params: {
    jobId: number
    status: JobStatus
    notes?: string
  }): Promise<string> {
    this.ensureDb()

    const updates = params.notes
      ? `status = ?, notes = ?, updated_at = datetime('now')`
      : `status = ?, updated_at = datetime('now')`

    const args = params.notes
      ? [params.status, params.notes, params.jobId]
      : [params.status, params.jobId]

    execSql(this, `UPDATE job_listings SET ${updates} WHERE id = ?`, args)

    return `Job ${params.jobId} updated to "${params.status}"`
  }

  @callable()
  async getPipeline(): Promise<{
    listings: JobListing[]
    stats: JobSearchResponse["pipelineUpdate"]
  }> {
    this.ensureDb()

    const rows = execSql(
      this,
      `SELECT * FROM job_listings ORDER BY
         CASE status
           WHEN 'discovered' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'applied' THEN 3
           WHEN 'interview' THEN 4
           WHEN 'offer' THEN 5
           WHEN 'rejected' THEN 6
         END,
         updated_at DESC`,
    )

    const listings: JobListing[] = rows.map((r: any) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      description: r.description,
      url: r.url,
      matchScore: r.match_score,
      status: r.status,
      priority: r.priority,
      notes: r.notes,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))

    return { listings, stats: this.getPipelineStats() }
  }

  // ---------------------------------------------------------------------------
  // Follow-ups
  // ---------------------------------------------------------------------------

  @callable()
  async getDueFollowUps(): Promise<FollowUp[]> {
    this.ensureDb()

    const rows = execSql(
      this,
      `SELECT * FROM follow_ups
         WHERE completed = 0 AND due_date <= date('now')
         ORDER BY due_date ASC`,
    )

    return rows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      dueDate: r.due_date,
      note: r.note,
      completed: r.completed === 1,
    }))
  }

  @callable()
  async addFollowUp(params: {
    jobId: number
    dueDate: string
    note?: string
  }): Promise<string> {
    this.ensureDb()

    execSql(
      this,
      `INSERT INTO follow_ups (job_id, due_date, note) VALUES (?, ?, ?)`,
      [params.jobId, params.dueDate, params.note ?? null],
    )

    return `Follow-up scheduled for ${params.dueDate}`
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  @callable()
  async getStats(): Promise<JobSearchResponse["pipelineUpdate"]> {
    this.ensureDb()
    return this.getPipelineStats()
  }

  @callable()
  async getCoverLettersForJob(jobId: number): Promise<CoverLetter[]> {
    this.ensureDb()

    const rows = execSql(
      this,
      `SELECT * FROM cover_letters WHERE job_id = ? ORDER BY version DESC`,
      [jobId],
    )

    return rows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      version: r.version,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getPipelineStats(): JobSearchResponse["pipelineUpdate"] {
    const counts = execSql(
      this,
      `SELECT status, COUNT(*) as count FROM job_listings GROUP BY status`,
    )

    const byStatus: Record<JobStatus, number> = {
      discovered: 0,
      draft: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
    }

    let total = 0
    for (const row of counts) {
      const c = Number(row.count) || 0
      byStatus[row.status as JobStatus] = c
      total += c
    }

    const dueFollowUps =
      Number(
        execSql(
          this,
          `SELECT COUNT(*) as count FROM follow_ups
           WHERE completed = 0 AND due_date <= date('now')`,
        )[0]?.count,
      ) || 0

    return { total, byStatus, dueFollowUps }
  }
}

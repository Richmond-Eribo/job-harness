import { Agent, callable } from "agents"
import { generateText, tool, isStepCount } from "ai"
import { z } from "zod"
import { getModel, getParams } from "../llm"
import type {
  Env,
  JobSource,
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
  // ── Operator-configured job websites ─────────────────────────────────
  // The agent's search tools REFUSE any URL whose origin doesn't match an
  // enabled row here. This is the runtime guardrail — the system prompt is
  // a secondary safety net. Sources are managed from the dashboard, not code.
  execSql(
    agent,
    `CREATE TABLE IF NOT EXISTS job_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      search_url_template TEXT,
      notes TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
}

// =============================================================================
// Self-healing schema migration for job_sources — NOT NULL → nullable.
// =============================================================================
// SQLite cannot ALTER a column to drop its NOT NULL constraint; the only way
// is the CREATE-TABLE…COPY…DROP…RENAME rebuild. This stays idempotent by
// reading PRAGMA table_info and only rebuilding when it detects the OLD
// `notnull: 1` `search_url_template` column. Fresh DOs (table not yet
// created — pr alleles empty -> skip) and already-migrated DOs (notnull: 0)
// short-circuit. Runs unconditionally on every ensureDb so existing users get
// migrated the first time they hit the DO after this deploy — same additive-
// migration shape the Harness relies on for free-tier DO SQLite. Not gated by
// a one-shot bool (the repo's documented DO-SQLite gotcha: persisted state
// flags silently skip mutations on existing DOs).
function migrateJobSourcesSchema(agent: SqlAgent) {
  const cols = execSql(agent, `PRAGMA table_info(job_sources)`).map(
    (c: any) => ({ name: c.name, notnull: c.notnull }),
  )
  const col = cols.find(c => c.name === "search_url_template")
  // Early return: table doesn't exist yet (empty pr alleles), or column is
  // already nullable. Either way the DO is in the desired state.
  if (!col || col.notnull === 0) return
  execSql(
    agent,
    `CREATE TABLE job_sources__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      search_url_template TEXT,
      notes TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    agent,
    `INSERT INTO job_sources__new (id, name, base_url, search_url_template, notes, enabled, created_at)
     SELECT id, name, base_url, search_url_template, notes, enabled, created_at FROM job_sources`,
  )
  execSql(agent, `DROP TABLE job_sources`)
  execSql(agent, `ALTER TABLE job_sources__new RENAME TO job_sources`)
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
// Live-website fetch + parse (replaces the old hardcoded job-board feed fetchers)
// =============================================================================
// The agent NEVER hand-builds URLs or sees raw HTML. `fetchAndParse` does the
// fetching and extracts a compact structure (title + truncated text + resolved
// links) via Cloudflare's HTMLRewriter — not regex. Regex-scraping HTML breaks
// the moment a site changes markup, and worse, leaks script/style noise into
// the model's context. HTMLRewriter is a streaming SAX-like parser that runs
// natively in the Workers runtime, so it's both correct and cheap.
//
// The origin guard in `searchJobs`'s tools (search_site / fetch_page) refuses
// any URL whose origin doesn't match an enabled `job_sources` row. That is the
// actual security boundary — the prompt is advisory.
// =============================================================================

interface ParsedPage {
  url: string
  title: string
  // Truncated so a single bloated listing can't dominate the model's context.
  text: string
  links: Array<{ text: string; href: string }>
}

/** Resolve a possibly-relative href against the page's origin. */
function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}

/**
 * Fetch a URL and parse it into a compact structure via HTMLRewriter.
 * - `<title>` → ParsedPage.title
 * - `<body>` text nodes → ParsedPage.text (truncated to ~2000 chars)
 * - `<a href>` → ParsedPage.links (resolved to absolute, deduped, capped at 100)
 *
 * Script/style content is skipped entirely so the model doesn't see JS.
 * Never throws — returns a best-effort object on any failure so a single bad
 * page can't kill the agent's search.
 */
async function fetchAndParse(url: string, origin: string): Promise<ParsedPage> {
  const out: ParsedPage = { url, title: "", text: "", links: [] }
  const seenLinks = new Set<string>()
  let textBuf = ""
  let inSkip = 0 // depth inside <script>/<style>/<noscript>
  const TEXT_CAP = 2000
  const LINK_CAP = 100

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        // A honest UA — some sites 403 the default Workers fetcher UA.
        "User-Agent": "Mozilla/5.0 (compatible; job-agent/1.0)",
      },
      redirect: "follow",
    })
    if (!res.ok || !res.body) {
      out.title = `(fetch failed: HTTP ${res.status})`
      return out
    }

    const rewriter = new HTMLRewriter()
      .on("title", {
        text(t) {
          out.title += t.text
          if (t.lastInTextNode) out.title = out.title.trim().slice(0, 300)
        },
      })
      .on("script,style,noscript", {
        element(el) {
          inSkip++
          el.onEndTag(() => {
            // Only pop when actually inside, in case of malformed nesting.
            if (inSkip > 0) inSkip--
          })
        },
      })
      .on("a[href]", {
        element(el) {
          if (out.links.length >= LINK_CAP) return
          const href = el.getAttribute("href")
          if (!href) return
          const abs = resolveUrl(href, origin)
          if (!abs || seenLinks.has(abs)) return
          seenLinks.add(abs)
          // Stash a placeholder; the text handler below fills `.text`.
          out.links.push({ text: "", href: abs })
        },
        text(t) {
          // Attach to the most recently pushed link (best-effort; HTMLRewriter
          // emits child text after the element handler opened it).
          const last = out.links[out.links.length - 1]
          if (last) last.text += t.text
          if (t.lastInTextNode && last) {
            last.text = last.text.trim().slice(0, 160)
          }
        },
      })
      .on("*", {
        // Body-text accumulator. Fires for every text node not consumed above.
        text(t) {
          if (inSkip > 0) return
          if (textBuf.length >= TEXT_CAP) return
          textBuf += t.text
          if (textBuf.length > TEXT_CAP) {
            textBuf = textBuf.slice(0, TEXT_CAP)
          }
        },
      })

    await rewriter.transform(res).text()
    out.text = textBuf.trim()
    // Drop links with no eligible text (often nav/asset hrefs).
    out.links = out.links.filter(l => l.text.length > 0)
    return out
  } catch (err: any) {
    out.title = `(fetch error: ${err?.message ?? String(err)})`
    return out
  }
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
    // Always run initDb() — every CREATE TABLE IF NOT EXISTS is idempotent, so
    // re-running on every call is cheap and lets new tables (like job_sources,
    // added in a later version than the rest) appear WITHOUT clearing the DO's
    // persisted SQLite. The `initialized` flag is kept for state introspection
    // but no longer gates schema creation. This is the same pattern the Harness
    // uses; it's the cleanest way to ship additive migrations on the free-tier
    // DO SQLite without a real migration framework.
    initDb(this)
    // Relax any pre-existing NOT NULL search_url_template column to nullable,
    // idempotently. Safe to run on every call — short-circuits when already
    // migrated. See migrateJobSourcesSchema for the rationale.
    migrateJobSourcesSchema(this)
    if (!this.state.initialized) {
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

    // All fields default to null; the kv table is sparse (only set keys exist).
    // Keep this in sync with the UserProfile type (@agent-harness/shared-types)
    // and the /api/onboarding allowlist in src/index.ts.
    const profile: Record<string, string | null> = {
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
    }

    for (const row of rows) {
      profile[row.key as string] = row.value as string
    }

    return profile as unknown as UserProfile
  }

  // ---------------------------------------------------------------------------
  // Job search (autonomous, site-scoped discovery — replaced the hardcoded
  // feed fetchers in v5). Uses a generateText loop with tools that fetch+parse
  // live pages. The runtime guard (origin must match an enabled job_sources
  // row) is enforced in the tools themselves; the model never sees raw HTML.
  // ---------------------------------------------------------------------------

  @callable()
  async searchJobs(request: JobSearchRequest): Promise<JobSearchResponse> {
    this.ensureDb()

    const profileStr = getProfileString(this)
    const criteria = request.criteria
    const maxResults = request.maxResults ?? 5
    // Page ceiling — bounds LLM cost. ~3 steps per page (search, open, save x N).
    const maxPages = Math.max(1, Math.min(5, Math.ceil(maxResults / 2)))

    const agent = this

    // ── Trace recorder (buffer + return) ────────────────────────────────
    // The job-agent runs its OWN multi-step LLM loop below (search_site →
    // fetch_page → save_job). We buffer every step's prompt / reasoning /
    // text / tool calls / results / tokens and return them as `__trace` on
    // the response. The harness ingests them nested under the discover_jobs
    // tool call, so the dashboard shows the real browsing the agent did —
    // previously invisible. No sink: this DO doesn't write to trace_events.
    const runId = request.runId ?? "job-search-standalone"
    const recorder = new TraceRecorder({
      agent: "job-agent",
      runId,
      redactKeys: obsConfig.logging?.redactToolArgs ?? [],
    })
    recorder.recordRunStart(`job search: ${criteria}`, maxPages * 6, 0)

    // ── Origin guard helper ──────────────────────────────────────────────
    // The actual security boundary. Returns the source row whose origin
    // matches, or null if the URL isn't on an allowed site.
    const sourceForUrl = (url: string): JobSource | null => {
      let origin: string
      try {
        origin = new URL(url).origin
      } catch {
        return null
      }
      const rows = execSql(agent, `SELECT * FROM job_sources WHERE enabled = 1`)
      for (const r of rows as any[]) {
        try {
          if (new URL(r.base_url).origin === origin) {
            return {
              id: r.id,
              name: r.name,
              baseUrl: r.base_url,
              searchUrlTemplate: r.search_url_template,
              notes: r.notes,
              enabled: true,
              createdAt: r.created_at,
            }
          }
        } catch {
          // malformed base_url in DB — skip
        }
      }
      return null
    }

    const jobSearchTools = {
      list_job_sources: tool({
        description:
          "List the job websites the user has configured for you to search. Each has an id, name and base_url. Use the id to call search_site.",
        inputSchema: z.object({}),
        execute: async () => {
          const rows = execSql(
            agent,
            `SELECT id, name, base_url, search_url_template, notes FROM job_sources WHERE enabled = 1 ORDER BY id`,
          )
          return JSON.stringify(
            rows.map((r: any) => ({
              id: r.id,
              name: r.name,
              baseUrl: r.base_url,
              // surfaces whether this source supports query/location filtering
              // (has a search template) or is browse-only, so the model knows
              // whether search_site's query arg will be effective.
              hasSearchTemplate: !!r.search_url_template,
              notes: r.notes,
            })),
          )
        },
      }),

      search_site: tool({
        description:
          "Open a configured job site. IF the source has a search template (hasSearchTemplate=true in list_job_sources), the query/location fills the template and returns filtered results. IF it is browse-only (hasSearchTemplate=false), query/location are IGNORED and the site's base page is returned — then you navigate its links with fetch_page. Pass the sourceId (never a hand-built URL). Returns parsed page text and links, not raw HTML.",
        inputSchema: z.object({
          sourceId: z.number().int(),
          query: z
            .string()
            .describe("role/keywords to search for, e.g. 'Senior TypeScript'"),
          location: z
            .string()
            .optional()
            .describe("location filter, e.g. 'London' or 'Remote'"),
          page: z
            .number()
            .int()
            .optional()
            .describe("result page number, starting at 1. Default 1."),
        }),
        execute: async ({ sourceId, query, location, page }) => {
          const src = execSql(
            agent,
            `SELECT * FROM job_sources WHERE id = ? AND enabled = 1`,
            [sourceId],
          )[0] as any
          if (!src) {
            return JSON.stringify({
              error: `source id ${sourceId} not found or disabled`,
            })
          }
          const baseUrl = src.base_url as string
          // Two modes: templated sources filter by query/location (safe
          // server-side fill — encodeURIComponent prevents query-param
          // injection and the model can't override the base origin), while
          // browse-only sources just return the base page and rely on the
          // model navigating links via fetch_page.
          if (src.search_url_template) {
            const url = (src.search_url_template as string)
              .replaceAll("{query}", encodeURIComponent(query))
              .replaceAll("{location}", encodeURIComponent(location ?? ""))
              .replaceAll("{page}", String(page ?? 1))
            return await fetchAndParse(url, baseUrl)
          }
          return await fetchAndParse(baseUrl, baseUrl)
        },
      }),

      fetch_page: tool({
        description:
          "Open a specific link you found (e.g. a job posting) and read its content. The URL MUST be on the same origin as one of the configured job_sources — otherwise this returns an error. Use after search_site to read the actual posting before deciding to save.",
        inputSchema: z.object({
          url: z.string().describe("Absolute URL on a configured job source"),
        }),
        execute: async ({ url }) => {
          const src = sourceForUrl(url)
          if (!src) {
            return JSON.stringify({
              error:
                "URL is outside the configured job sources. Only open links on sites you found via list_job_sources / search_site.",
            })
          }
          return await fetchAndParse(url, src.baseUrl)
        },
      }),

      save_job: tool({
        description:
          "Save a real job listing you confirmed by visiting its page with fetch_page. Never invent a company, title, or URL — every field must come from a page you actually opened. Score matchScore 0.0–1.0 based on profile fit; only call this for listings scoring >= 0.4.",
        inputSchema: z.object({
          company: z.string(),
          title: z.string(),
          description: z
            .string()
            .describe("the relevant excerpt from the fetched posting"),
          url: z.string().describe("the URL you fetched via fetch_page"),
          sourceName: z
            .string()
            .describe("the name of the job source site, from list_job_sources"),
          matchScore: z.number().min(0).max(1),
        }),
        execute: async job => {
          // Re-verify the URL is on an allowed origin before persisting — the
          // model could in theory pass a URL it never fetched.
          if (!sourceForUrl(job.url)) {
            return JSON.stringify({
              error: `refused: url ${job.url} is not on a configured job source`,
            })
          }
          // Dedupe by URL or company+title
          const dup = execSql(
            agent,
            `SELECT id FROM job_listings
               WHERE (url = ? AND url IS NOT NULL AND url <> '')
                  OR (company = ? AND title = ?)
             LIMIT 1`,
            [job.url, job.company, job.title],
          )
          if (dup.length > 0) {
            return JSON.stringify({
              skipped: true,
              reason: "duplicate (already in pipeline)",
            })
          }
          execSql(
            agent,
            `INSERT INTO job_listings (company, title, description, url, match_score, source, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              job.company,
              job.title,
              String(job.description).slice(0, 8000),
              job.url,
              job.matchScore,
              job.sourceName,
              `auto-discovered via ${job.sourceName}`,
            ],
          )
          return JSON.stringify({
            saved: true,
            company: job.company,
            title: job.title,
            matchScore: job.matchScore,
          })
        },
      }),
    }

    // ── The agent run ────────────────────────────────────────────────────
    const systemPrompt = `You are a job search agent that browses real job websites the user has configured.

CANDIDATE PROFILE:
${profileStr}

SEARCH CRITERIA: "${criteria}"

Available tools:
- list_job_sources: see which job websites you are allowed to search. Each
  source shows hasSearchTemplate: true (supports query/location filtering) or
  false (browse-only — you navigate from its home/listings page).
- search_site: open a site. If the source has a search template, your query /
  location filter the results; if it is browse-only, query/location are IGNORED
  and you get back the site's base page to navigate from.
- fetch_page: open a link you found (a job posting, or a "next page" link).
- save_job: record a listing AFTER you have opened its page with fetch_page.

How to work:
1. Call list_job_sources first. Pick the site(s) most likely to have relevant
   roles for this search — you do not have to search every site on every run.
2. For a templated source (hasSearchTemplate=true): call search_site with a
   concise query derived from the criteria. Read the returned links and page
   text.
   For a browse-only source (hasSearchTemplate=false): call search_site to load
   its base page, then follow the links on it with fetch_page to reach the job
   listings (e.g. a Jobs/Careers nav link, then a posting).
3. If a result looks relevant, call fetch_page on its link to read the actual
   job posting before saving. NEVER save a listing you have not opened.
4. If a templated source's results are paginated and the profile match is
   promising, you may fetch the next page (search_site again with page+1)
   instead of opening more listings on the current page. Use your judgement —
   do not page through a site that is returning no relevant results.
5. Only call save_job for listings you retrieved from a tool. NEVER invent a
   company, title, or URL. Every save_job call must reference a URL you
   actually fetched via fetch_page.
6. Score matchScore 0.0–1.0 based on fit between the profile and the role. Only
   save listings scoring >= 0.4.
7. Stop once you have enough strong candidates for this run (aim for ${maxResults})
   or you have searched ${maxPages} pages without new relevant results, whichever
   comes first.

You will not always find something on every source. That is fine — report what
you found and stop rather than fabricating results to fill a quota.`
    const userPrompt = `Find up to ${maxResults} real job listings matching "${criteria}" for the candidate profile above. Use the tools; do not write listings from memory.`

    // Snapshot prompts for the trace.
    recorder.recordSystem("system-prompt", systemPrompt)
    recorder.recordPrompt(0, [{ role: "user", content: userPrompt }])

    try {
      const model = getModel(this.env)
      const result = await generateText({
        model,
        tools: jobSearchTools,
        stopWhen: isStepCount(maxPages * 6),
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
    } catch (err: any) {
      // Non-fatal — the surfaced result below is what the pipeline ended with.
      // A model/API error mid-search still leaves any listings the agent
      // already saved via save_job in place. Record the error into the trace.
      recorder.recordError(null, err?.message ?? String(err))
    }

    // ── Surface what the agent actually persisted this run ──────────────
    const recentRows = execSql(
      this,
      `SELECT company, title, description, url, match_score FROM job_listings
         WHERE source <> 'manual'
         ORDER BY created_at DESC LIMIT ?`,
      [maxResults],
    )
    const newListings: JobSearchResponse["newListings"] = recentRows.map(
      (r: any) => ({
        company: r.company,
        title: r.title,
        description: String(r.description ?? "").slice(0, 2000),
        url: r.url ?? "",
        matchScore: r.match_score ?? 0,
      }),
    )

    return {
      newListings,
      pipelineUpdate: this.getPipelineStats(),
      // Sub-agent inner-loop trace — ingested by the harness recorder and
      // nested under the discover_jobs tool call in the transcript.
      __trace: recorder.toSubAgentTrace(),
    }
  }

  // ---------------------------------------------------------------------------
  // Job source management — operator-configured sites the agent may browse.
  // These are the dashboard-facing CRUD RPCs; the agent itself reads
  // job_sources via the list_job_sources tool inside the search run.
  // ---------------------------------------------------------------------------

  @callable()
  async addJobSource(source: {
    name: string
    baseUrl: string
    // Optional. When present (and containing the {query}/{location}/{page}
    // placeholders) search_site fills it to filter results. When absent the
    // source is browse-only — the model loads the base page and navigates via
    // fetch_page. Optional across the board so the UI never has to force the
    // user to hand-author a search URL template.
    searchUrlTemplate?: string | null
    notes?: string
  }): Promise<{ id: number; message: string }> {
    this.ensureDb()
    // Only baseUrl has a hard shape requirement. The template is fully
    // optional; if provided we normalise empty strings to null so the table
    // never holds a bogus empty-string template that breaks {query} fill.
    if (
      source.searchUrlTemplate !== undefined &&
      source.searchUrlTemplate !== null
    ) {
      const trimmed = source.searchUrlTemplate.trim()
      if (trimmed !== "" && !trimmed.includes("{query}")) {
        throw new Error(
          "searchUrlTemplate, when provided, must contain a {query} placeholder, e.g. https://example.com/jobs/{query}",
        )
      }
    }
    try {
      // eslint-disable-next-line no-new
      new URL(source.baseUrl)
    } catch {
      throw new Error(`baseUrl "${source.baseUrl}" is not a valid absolute URL`)
    }
    execSql(
      this,
      `INSERT INTO job_sources (name, base_url, search_url_template, notes) VALUES (?, ?, ?, ?)`,
      [
        source.name,
        source.baseUrl,
        source.searchUrlTemplate
          ? source.searchUrlTemplate.trim() || null
          : null,
        source.notes ?? null,
      ],
    )
    const row = execSql(this, `SELECT last_insert_rowid() as id`)[0] as any
    return {
      id: row.id,
      message: `Added job source "${source.name}" (${source.baseUrl})`,
    }
  }

  @callable()
  async listJobSources(): Promise<JobSource[]> {
    this.ensureDb()
    const rows = execSql(this, `SELECT * FROM job_sources ORDER BY id`)
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      searchUrlTemplate: r.search_url_template,
      notes: r.notes,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
    }))
  }

  @callable()
  async updateJobSource(
    id: number,
    patch: Partial<{
      name: string
      baseUrl: string
      // Optional/nullable: a source can be switched to browse-only by passing
      // null here. Same contract as addJobSource.
      searchUrlTemplate?: string | null
      notes: string
      enabled: boolean
    }>,
  ): Promise<string> {
    this.ensureDb()
    const sets: string[] = []
    const args: any[] = []
    if (patch.name !== undefined) {
      sets.push("name = ?")
      args.push(patch.name)
    }
    if (patch.baseUrl !== undefined) {
      sets.push("base_url = ?")
      args.push(patch.baseUrl)
    }
    if (patch.searchUrlTemplate !== undefined) {
      sets.push("search_url_template = ?")
      // Normalise empty-string and whitespace-only to null so the column
      // never ends up with a fake "" template that breaks the {query} fill.
      const v = patch.searchUrlTemplate?.trim() || null
      args.push(v)
    }
    if (patch.notes !== undefined) {
      sets.push("notes = ?")
      args.push(patch.notes)
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?")
      args.push(patch.enabled ? 1 : 0)
    }
    if (sets.length === 0) return `No fields to update for source ${id}.`
    args.push(id)
    execSql(
      this,
      `UPDATE job_sources SET ${sets.join(", ")} WHERE id = ?`,
      args,
    )
    return `Updated job source ${id}: ${sets.map(s => s.split(" ")[0]).join(", ")}`
  }

  @callable()
  async removeJobSource(id: number): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM job_sources WHERE id = ?`, [id])
    return `Removed job source ${id}`
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
    /** Where the job came from. 'manual' (operator) or a site name (agent). */
    source?: string
    /** Agent's fit assessment 0..1, for agent-discovered jobs. */
    matchScore?: number
  }): Promise<{ id: number; message: string }> {
    this.ensureDb()

    // Dedupe by URL or company+title so the agent can't add the same posting
    // twice across runs (it re-browses the same listings otherwise).
    const dup = execSql(
      this,
      `SELECT id FROM job_listings
         WHERE (? IS NOT NULL AND url = ? AND url <> '')
            OR (company = ? AND title = ?)
       LIMIT 1`,
      [job.url ?? null, job.url ?? null, job.company, job.title],
    )
    if (dup.length > 0) {
      return {
        id: (dup[0] as any).id,
        message: `Already in pipeline: ${job.title} at ${job.company}`,
      }
    }

    const source = job.source ?? "manual"
    execSql(
      this,
      `INSERT INTO job_listings (company, title, description, url, match_score, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        job.company,
        job.title,
        job.description ? String(job.description).slice(0, 8000) : null,
        job.url ?? null,
        job.matchScore ?? null,
        source,
        source === "manual" ? null : `agent-discovered via ${source}`,
      ],
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
    recorder.recordRunStart(`cover letter: ${job.company} / ${job.title}`, 1, 0)

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
  async deleteJob(params: { jobId: number }): Promise<string> {
    this.ensureDb()
    execSql(this, `DELETE FROM job_listings WHERE id = ?`, [params.jobId])
    return `Removed job ${params.jobId}`
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

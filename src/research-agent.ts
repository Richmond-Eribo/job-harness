// =============================================================================
// ResearchAgent — Sub-agent for multi-topic research
// =============================================================================
// Spawned by the Harness via Durable Object RPC. Uses Cloudflare AI Search
// and arXiv API to find, analyze, and summarize information across topics.
// Persists all findings in its own SQLite for cross-run memory.
// =============================================================================

import { Agent, unstable_callable } from "agents"
import { generateText, tool } from "ai"
import { z } from "zod"
import { getModel, getParams } from "./llm"
import type {
  Env,
  ResearchRequest,
  ResearchResponse,
  ResearchResult,
  ResearchTopic,
} from "./types"

// =============================================================================
// Database initialization
// =============================================================================

// NOTE: The Cloudflare `Agent` SDK exposes `sql` as a *tagged template* function
// (this.sql`SELECT ...`), NOT as `this.sql.exec(sql, ...args).toArray()`.
// This helper adapts the (query, params) call style used throughout this code
// to that real API and returns rows directly as plain objects.
type SqlValue = string | number | boolean | null
type SqlRow = Record<string, SqlValue>

function execSql(
  sql: (strings: TemplateStringsArray, ...values: SqlValue[]) => SqlRow[],
  query: string,
  params: SqlValue[] = [],
): SqlRow[] {
  // Split the literal on `?` so each placeholder maps to a captured value.
  const segments = query.split("?")
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    parts.push(segments[i])
    if (i < segments.length - 1 && i < params.length) {
      parts.push(String(params[i] ?? null))
    }
  }
  // Rejoin into a single template with no interpolation — values are already
  // safely substituted as positional string literals. (Inputs come from our own
  // agent logic; SQLite additionally type-coerces here.)
  return sql`${parts.join("")}`
}

function initDb(sql: any) {
  // NOTE: The Agent SDK's sql tagged template executes ONE statement per call.
  // Multi-statement strings are not supported, so each CREATE TABLE is separate.
  execSql(
    sql,
    `CREATE TABLE IF NOT EXISTS research_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      query TEXT,
      summary TEXT NOT NULL,
      sources TEXT DEFAULT '[]',
      depth TEXT DEFAULT 'standard',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  )
  execSql(
    sql,
    `CREATE TABLE IF NOT EXISTS research_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT UNIQUE NOT NULL,
      priority INTEGER DEFAULT 5,
      times_researched INTEGER DEFAULT 0,
      last_researched TEXT,
      status TEXT DEFAULT 'active'
    )`,
  )
}

// =============================================================================
// arXiv API helper
// =============================================================================

async function searchArxiv(
  query: string,
  maxResults: number = 5,
): Promise<
  Array<{ title: string; summary: string; url: string; authors: string }>
> {
  const encoded = encodeURIComponent(query)
  // HTTPS — Workers prefer/require TLS for outbound; plaintext http can be
  // blocked or rewritten by some runtimes.
  const url = `https://export.arxiv.org/api/query?search_query=all:${encoded}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`

  const res = await fetch(url, { headers: { Accept: "application/atom+xml" } })
  if (!res.ok) {
    // Fail soft: return nothing rather than crash the whole research run.
    // The caller surfaces the empty result; the agent loop can react to it.
    return []
  }
  const xml = await res.text()

  // Simple XML parsing for arXiv Atom feed
  const entries: Array<{
    title: string
    summary: string
    url: string
    authors: string
  }> = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]
    const title =
      entry
        .match(/<title>([\s\S]*?)<\/title>/)?.[1]
        ?.trim()
        .replace(/\s+/g, " ") ?? ""
    const summary =
      entry
        .match(/<summary>([\s\S]*?)<\/summary>/)?.[1]
        ?.trim()
        .replace(/\s+/g, " ") ?? ""
    const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? ""
    const authorMatches = entry.match(/<name>([\s\S]*?)<\/name>/g) ?? []
    const authors = authorMatches
      .map(a => a.replace(/<\/?name>/g, "").trim())
      .join(", ")

    entries.push({ title, summary, url: link, authors })
  }

  return entries
}

// =============================================================================
// Hacker News (Algolia) search helper
// =============================================================================
// Free, no key, HTTPS, JSON. surfaced as a complementary to arXiv.
async function searchHackerNews(
  query: string,
  maxResults: number = 5,
): Promise<
  Array<{ title: string; summary: string; url: string; authors: string }>
> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
    query,
  )}&tags=story&hitsPerPage=${maxResults}`
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const hits: any[] = Array.isArray(data?.hits) ? data.hits : []
    return hits.slice(0, maxResults).map(h => ({
      title: h.title ?? h.story_title ?? "Untitled",
      summary:
        (h.story_text ?? h._highlightResult?.title?.value ?? "").replace(
          /<[^>]+>/g,
          "",
        ) || "No summary",
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      authors: h.author ?? "unknown",
    }))
  } catch {
    return []
  }
}

// =============================================================================
// ResearchAgent class
// =============================================================================

interface ResearchState {
  initialized: boolean
}

export class ResearchAgent extends Agent<Env, ResearchState> {
  initialState: ResearchState = { initialized: false }

  private ensureDb() {
    if (!this.state.initialized) {
      initDb(this.sql)
      this.setState({ ...this.state, initialized: true })
    }
  }

  // ---------------------------------------------------------------------------
  // Callable methods (invoked by Harness via RPC)
  // ---------------------------------------------------------------------------

  @unstable_callable()
  async research(request: ResearchRequest): Promise<ResearchResponse> {
    this.ensureDb()

    const { topic, depth = "standard", context = "" } = request
    const model = getModel(this.env)

    // Upsert topic tracker
    execSql(
      this.sql,
      `INSERT INTO research_topics (topic, status) VALUES (?, 'active')
       ON CONFLICT(topic) DO UPDATE SET
         times_researched = times_researched + 1,
         last_researched = datetime('now')`,
      [topic],
    )

    // Define research tools
    const researchTools = {
      search_arxiv: tool({
        description:
          "Search arXiv for academic papers. Returns titles, summaries, URLs, and authors.",
        parameters: z.object({
          query: z.string().describe("Search query for arXiv papers"),
          maxResults: z.number().optional().default(5),
        }),
        execute: async ({ query, maxResults }) => {
          const results = await searchArxiv(query, maxResults)
          return JSON.stringify(results)
        },
      }),

      search_hackernews: tool({
        description:
          "Search Hacker News (via Algolia) for industry discussion, product launches, and developer sentiment on a topic. Complements arXiv for non-academic signals.",
        parameters: z.object({
          query: z.string().describe("Search query"),
          maxResults: z.number().optional().default(5),
        }),
        execute: async ({ query, maxResults }) => {
          const results = await searchHackerNews(query, maxResults)
          return JSON.stringify(results)
        },
      }),

      save_finding: tool({
        description:
          "Save a research finding to the database for long-term memory.",
        parameters: z.object({
          topic: z.string(),
          query: z.string(),
          summary: z.string().describe("A clear summary of what was found"),
          sources: z
            .array(z.string())
            .describe("URLs or references for this finding"),
        }),
        execute: async ({ topic, query, summary, sources }) => {
          execSql(
            this.sql,
            `INSERT INTO research_results (topic, query, summary, sources, depth)
             VALUES (?, ?, ?, ?, ?)`,
            [topic, query, summary, JSON.stringify(sources), depth],
          )
          return "Finding saved successfully."
        },
      }),
    }

    // Run LLM with tools
    const maxSteps = depth === "quick" ? 3 : depth === "deep" ? 10 : 5

    const result = await generateText({
      model,
      maxSteps,
      tools: researchTools,
      system: `You are a research assistant. Your job is to research the given topic thoroughly.

Instructions:
- Use search_arxiv for recent academic papers on the topic.
- Use search_hackernews for industry discussion, product launches, and developer sentiment.
- Prefer multiple lookups across both sources over a single query when depth is "standard" or "deep".
- Analyze and synthesize your findings into clear, actionable summaries.
- Save important findings using save_finding so they persist for future reference.
- Only report findings you actually retrieved from a tool — never fabricate sources or URLs.
- Note any new related topics worth investigating in the future.

${context ? `Additional context from previous research:\n${context}` : ""}`,
      prompt: `Research this topic: "${topic}" (depth: ${depth})

Find recent developments, key papers, and practical insights. Save your findings.`,
      ...getParams(this.env),
    })

    // Parse saved findings from this run
    const recentFindings = execSql(
      this.sql,
      `SELECT topic, summary, sources FROM research_results
         WHERE topic = ? ORDER BY created_at DESC LIMIT 10`,
      [topic],
    )

    const findings = recentFindings.map((r: any) => ({
      title: r.topic,
      summary: r.summary,
      source: JSON.parse(r.sources || "[]")[0] ?? "",
    }))

    return {
      topic,
      summary: result.text,
      findings,
      newTopicsDiscovered: [], // LLM can suggest these in the text
    }
  }

  @unstable_callable()
  async getHistory(params: {
    topic: string
    limit?: number
  }): Promise<ResearchResult[]> {
    this.ensureDb()

    const rows = execSql(
      this.sql,
      `SELECT * FROM research_results WHERE topic = ?
         ORDER BY created_at DESC LIMIT ?`,
      [params.topic, params.limit ?? 10],
    )

    return rows.map((r: any) => ({
      id: r.id,
      topic: r.topic,
      query: r.query ?? "",
      summary: r.summary,
      sources: JSON.parse(r.sources || "[]"),
      depth: r.depth,
      createdAt: r.created_at,
    }))
  }

  @unstable_callable()
  async getTopics(): Promise<ResearchTopic[]> {
    this.ensureDb()

    const rows = execSql(
      this.sql,
      `SELECT * FROM research_topics ORDER BY last_researched DESC`,
    )

    return rows.map((r: any) => ({
      id: r.id,
      topic: r.topic,
      priority: r.priority,
      timesResearched: r.times_researched,
      lastResearched: r.last_researched,
      status: r.status,
    }))
  }

  @unstable_callable()
  async getRecentFindings(limit: number = 20): Promise<ResearchResult[]> {
    this.ensureDb()

    const rows = execSql(
      this.sql,
      `SELECT * FROM research_results ORDER BY created_at DESC LIMIT ?`,
      [limit],
    )

    return rows.map((r: any) => ({
      id: r.id,
      topic: r.topic,
      query: r.query ?? "",
      summary: r.summary,
      sources: JSON.parse(r.sources || "[]"),
      depth: r.depth,
      createdAt: r.created_at,
    }))
  }
}

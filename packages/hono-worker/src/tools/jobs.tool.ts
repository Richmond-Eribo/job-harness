// =============================================================================
// Job-related tools — delegation to the JobApplicationAgent DO.
// =============================================================================
//  discover_jobs      → find REAL listings, never invented
//  write_cover_letter → tailored letter for a saved job by id
//  pipeline_status    → no-side-effects snapshot of the pipeline
//  list_jobs          → read saved jobs (optionally by stage)
//  set_job_status     → move a job to a new pipeline stage
// =============================================================================
import { tool } from "ai"
import { z } from "zod"
import { getAgentByName } from "agents"
import type { Env } from "../types"
import type { JobApplicationAgent } from "../agents"
import { withRpcRetry } from "../utils/rpc-retry"

type Advance = (toolName: string, input: string | null) => void

/** Shared holder for the active harness run id, so delegating tools can pass
 *  it to sub-agents for trace attribution. */
export type RunIdRef = { value: string }

// Resolve THIS user's JobApplicationAgent. The userId is the multi-tenant key —
// every job tool operates only on the owning user's data.
const JOB_AGENT = (env: Env, userId: string) =>
  getAgentByName<Env, JobApplicationAgent>(env.JOB_AGENT, userId)

export function makeDiscoverJobsTool(
  env: Env,
  advance: Advance,
  runIdRef: RunIdRef,
  userId: string,
) {
  return tool({
    description:
      "Delegate a job search to the JobAgent. It runs an LLM loop that browses the real job websites the operator has configured " +
      "(dashboard → Job sources) — opens search pages, reads postings, and saves only listings it actually visited. " +
      "Returns listings that now exist in your pipeline. Do not reference any job that did not come from this tool.",
    inputSchema: z.object({
      criteria: z
        .string()
        .describe(
          "Search criteria: role, stack, seniority, location. Derive every part from the candidate profile in your context — never assume a role, stack, or location the profile does not state.",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Cap on listings to return. Default 5."),
    }),
    execute: async ({ criteria, maxResults }) => {
      advance(
        "discover_jobs",
        JSON.stringify({ criteria, maxResults }).slice(0, 2000),
      )
      const agent = await JOB_AGENT(env, userId)
      // Pass the harness runId so the job-agent's inner-loop trace can be
      // attributed and later nested under this discover_jobs call.
      const result = await withRpcRetry(() =>
        agent.searchJobs({
          criteria,
          maxResults: maxResults ?? 5,
          runId: runIdRef.value,
        }),
      )
      return JSON.stringify(result)
    },
  })
}

export function makeWriteCoverLetterTool(
  env: Env,
  advance: Advance,
  runIdRef: RunIdRef,
  userId: string,
) {
  return tool({
    description:
      "Generate a tailored cover letter for a job ALREADY in your pipeline. Requires a valid jobId (from discover_jobs or pipeline_status). Errors if the id doesn't exist.",
    inputSchema: z.object({
      jobId: z.number().int().describe("An existing job id from your pipeline"),
    }),
    execute: async ({ jobId }) => {
      advance("write_cover_letter", String(jobId))
      const agent = await JOB_AGENT(env, userId)
      try {
        const result = await withRpcRetry(() =>
          agent.generateCoverLetter({ jobId, runId: runIdRef.value }),
        )
        return JSON.stringify(result)
      } catch (e: any) {
        return `Could not write cover letter: ${e.message}. Confirm jobId exists via pipeline_status.`
      }
    },
  })
}

export function makeWriteTailoredCvTool(
  env: Env,
  advance: Advance,
  runIdRef: RunIdRef,
  userId: string,
) {
  return tool({
    description:
      "Generate a CV tailored to a job ALREADY in your pipeline, grounded in the user's real uploaded CV — " +
      "it re-orders and re-emphasizes real experience, never invents any. Requires a valid jobId and the user's parsed CV text. " +
      "Use it for strong matches alongside write_cover_letter so the user can review both documents before applying.",
    inputSchema: z.object({
      jobId: z.number().int().describe("An existing job id from your pipeline"),
    }),
    execute: async ({ jobId }) => {
      advance("write_tailored_cv", String(jobId))
      const agent = await JOB_AGENT(env, userId)
      try {
        const result = await withRpcRetry(() =>
          agent.generateTailoredCv({ jobId, runId: runIdRef.value }),
        )
        return JSON.stringify(result)
      } catch (e: any) {
        return `Could not tailor CV: ${e.message}. Confirm jobId exists via pipeline_status and that the user has uploaded a parsable CV.`
      }
    },
  })
}

export function makePipelineStatusTool(env: Env, userId: string) {
  return tool({
    description:
      "Read the current job pipeline: all listings grouped by stage (discovered, draft, applied, interview, offer, rejected) plus due follow-ups. No side effects.",
    inputSchema: z.object({}),
    execute: async () => {
      const agent = await JOB_AGENT(env, userId)
      return JSON.stringify(await withRpcRetry(() => agent.getPipeline()))
    },
  })
}

export function makeListJobsTool(env: Env, userId: string) {
  return tool({
    description: "List saved jobs, optionally filtered by status.",
    inputSchema: z.object({
      status: z
        .enum([
          "discovered",
          "draft",
          "applied",
          "interview",
          "offer",
          "rejected",
        ])
        .optional(),
    }),
    execute: async ({ status }) => {
      const agent = await JOB_AGENT(env, userId)
      const pipe = await withRpcRetry(() => agent.getPipeline())
      const listings = status
        ? pipe.listings.filter(j => j.status === status)
        : pipe.listings
      return JSON.stringify(listings)
    },
  })
}

export function makeSetJobStatusTool(env: Env, userId: string) {
  return tool({
    description: "Move a job to a new pipeline stage, optionally with notes.",
    inputSchema: z.object({
      jobId: z.number().int(),
      status: z.enum([
        "discovered",
        "draft",
        "applied",
        "interview",
        "offer",
        "rejected",
      ]),
      notes: z.string().optional(),
    }),
    execute: async ({ jobId, status, notes }) => {
      const agent = await JOB_AGENT(env, userId)
      return await withRpcRetry(() =>
        agent.updateStatus({ jobId, status, notes }),
      )
    },
  })
}

/**
 * save_job — lets the agent record a job it found while BROWSING (via the
 * browser tools) into the pipeline. This is the bridge between the browser
 * capability (read login-walled pages) and the jobs pipeline (track + apply).
 * Without it, listings the agent reads on Indeed/LinkedIn can't be saved.
 *
 * Every field must come from a page the agent actually opened — never invented.
 */
export function makeSaveJobTool(env: Env, advance: Advance, userId: string) {
  return tool({
    description:
      "Save a job you found while browsing into the pipeline. Use this after you've opened a real posting with browser_navigate/browser_observe and read its details. " +
      "Every field (company, title, url, description) MUST come from a page you actually opened — never invent them. " +
      "Score matchScore 0.0–1.0 based on fit against the candidate profile. " +
      "This is how browser-discovered jobs enter the pipeline (discover_jobs is the other path, for sites the JobAgent can scrape directly).",
    inputSchema: z.object({
      company: z.string().describe("Company name, from the posting"),
      title: z.string().describe("Job title, from the posting"),
      url: z
        .string()
        .describe("The posting URL you opened in the browser"),
      description: z
        .string()
        .describe("The relevant excerpt from the posting (requirements, stack, location)"),
      sourceName: z
        .string()
        .describe("The site you found it on, e.g. 'indeed', 'linkedin'"),
      matchScore: z
        .number()
        .min(0)
        .max(1)
        .describe("Your fit assessment 0.0–1.0 against the profile"),
    }),
    execute: async ({ company, title, url, description, sourceName, matchScore }) => {
      advance(
        "save_job",
        JSON.stringify({ company, title, url, sourceName, matchScore }).slice(0, 2000),
      )
      const agent = await JOB_AGENT(env, userId)
      const result = await withRpcRetry(() =>
        agent.addJob({
          company,
          title,
          url,
          description,
          source: sourceName,
          matchScore,
        }),
      )
      return JSON.stringify(result)
    },
  })
}

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

const JOB_AGENT = (env: Env) =>
  getAgentByName<Env, JobApplicationAgent>(env.JOB_AGENT, "main")

export function makeDiscoverJobsTool(env: Env, advance: Advance) {
  return tool({
    description:
      "Ask the JobAgent to find REAL job listings matching criteria. Returns listings that now exist in your pipeline. " +
      "Do not reference any job that did not come from this tool or the API. If nothing matched, it returns an empty list.",
    inputSchema: z.object({
      criteria: z
        .string()
        .describe(
          "Search criteria: role, stack, seniority, location, etc. e.g. 'senior TypeScript + AI, remote'",
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
      const agent = await JOB_AGENT(env)
      const result = await withRpcRetry(() =>
        agent.searchJobs({
          criteria,
          maxResults: maxResults ?? 5,
        }),
      )
      return JSON.stringify(result)
    },
  })
}

export function makeWriteCoverLetterTool(env: Env, advance: Advance) {
  return tool({
    description:
      "Generate a tailored cover letter for a job ALREADY in your pipeline. Requires a valid jobId (from discover_jobs or pipeline_status). Errors if the id doesn't exist.",
    inputSchema: z.object({
      jobId: z.number().int().describe("An existing job id from your pipeline"),
    }),
    execute: async ({ jobId }) => {
      advance("write_cover_letter", String(jobId))
      const agent = await JOB_AGENT(env)
      try {
        const result = await withRpcRetry(() =>
          agent.generateCoverLetter({ jobId }),
        )
        return JSON.stringify(result)
      } catch (e: any) {
        return `Could not write cover letter: ${e.message}. Confirm jobId exists via pipeline_status.`
      }
    },
  })
}

export function makePipelineStatusTool(env: Env) {
  return tool({
    description:
      "Read the current job pipeline: all listings grouped by stage (discovered, draft, applied, interview, offer, rejected) plus due follow-ups. No side effects.",
    inputSchema: z.object({}),
    execute: async () => {
      const agent = await JOB_AGENT(env)
      return JSON.stringify(await withRpcRetry(() => agent.getPipeline()))
    },
  })
}

export function makeListJobsTool(env: Env) {
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
      const agent = await JOB_AGENT(env)
      const pipe = await withRpcRetry(() => agent.getPipeline())
      const listings = status
        ? pipe.listings.filter(j => j.status === status)
        : pipe.listings
      return JSON.stringify(listings)
    },
  })
}

export function makeSetJobStatusTool(env: Env) {
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
      const agent = await JOB_AGENT(env)
      return await withRpcRetry(() =>
        agent.updateStatus({ jobId, status, notes }),
      )
    },
  })
}

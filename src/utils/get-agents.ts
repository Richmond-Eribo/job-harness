import { routeAgentRequest, getAgentByName } from "agents"
import type { Env } from "../types"
import { Harness } from "../agents/harness"
import { ResearchAgent } from "../agents/research-agent"
import { JobApplicationAgent } from "../agents/job-agent"

export const HARNESS_ID = "main" // single long-running harness instance

// -----------------------------------------------------------------------------
// Helper: typed agent stubs for this request
// -----------------------------------------------------------------------------

export async function getAgents(env: Env) {
  const harness = await getAgentByName<Env, Harness>(env.HARNESS, HARNESS_ID)
  const jobAgent = await getAgentByName<Env, JobApplicationAgent>(
    env.JOB_AGENT,
    HARNESS_ID,
  )
  const researchAgent = await getAgentByName<Env, ResearchAgent>(
    env.RESEARCH_AGENT,
    HARNESS_ID,
  )
  return { harness, jobAgent, researchAgent }
}

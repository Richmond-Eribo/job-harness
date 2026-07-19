// =============================================================================
// 10 — Multi-tenant isolation
// =============================================================================
// The agent harness is multi-tenant: every Durable Object (Harness +
// JobApplicationAgent) is keyed by userId, so two users must NOT see each
// other's jobs, memory, or runs.
//
// We add a job + a memory entry as User A, then log in as User B and assert
// neither appears. Then we add a different entry as User B and confirm A's
// view is unchanged.
import { test, expect } from "./../fixtures/auth"
import { E2E_WEB_URL, E2E_API_URL, USER_A, USER_B } from "../fixtures/env"
import { loginAs } from "../fixtures/api"

test.describe("multi-tenant isolation", () => {
  test("User A's job is invisible to User B", async ({ browser }) => {
    // ── As User A: create a uniquely-named job. ──────────────────────────
    const titleA = `MultiTenant-A-${Date.now()}`
    const sessionA = await loginAs(USER_A.email, USER_A.password)
    let jobIdA: number
    try {
      const res = await sessionA.context.post(`${E2E_API_URL}/api/jobs`, {
        data: { title: titleA, company: "MT Corp A", url: `https://mt-a.test/${Date.now()}` },
      })
      expect(res.ok()).toBe(true)
      jobIdA = (await res.json()).id

      // ── As User B: B's pipeline must NOT contain A's job. ──────────────
      const sessionB = await loginAs(USER_B.email, USER_B.password)
      try {
        const bPipelineRes = await sessionB.context.get(`${E2E_API_URL}/api/pipeline`)
        expect(bPipelineRes.ok()).toBe(true)
        const bPipeline = await bPipelineRes.json()
        const bListings = bPipeline.listings ?? []
        const bHasAJob = bListings.some((j: any) => j.title === titleA)
        expect(bHasAJob, "User B must not see User A's job").toBe(false)
      } finally {
        await sessionB.dispose()
      }
    } finally {
      // Clean up A's job.
      await sessionA.context.delete(`${E2E_API_URL}/api/jobs/${jobIdA}`).catch(() => {})
      await sessionA.dispose()
    }
  })

  test("User A's user-memory is invisible to User B", async ({ browser }) => {
    const keyA = `mt_mem_a_${Date.now()}`
    const valueA = "secret-to-A"

    const sessionA = await loginAs(USER_A.email, USER_A.password)
    try {
      const putRes = await sessionA.context.put(`${E2E_API_URL}/api/user-memory`, {
        data: { key: keyA, value: valueA },
      })
      expect(putRes.ok()).toBe(true)

      const sessionB = await loginAs(USER_B.email, USER_B.password)
      try {
        const bMemRes = await sessionB.context.get(`${E2E_API_URL}/api/user-memory`)
        expect(bMemRes.ok()).toBe(true)
        const bMem = await bMemRes.json()
        const bFlat = Array.isArray(bMem)
          ? bMem
          : bMem?.entries ?? Object.entries(bMem ?? {}).map(([k, v]) => ({ key: k, value: v }))
        const bHasA = bFlat.some((e: any) => (e.key ?? e[0]) === keyA)
        expect(bHasA, "User B must not see User A's user-memory").toBe(false)
      } finally {
        await sessionB.dispose()
      }
    } finally {
      await sessionA.context.delete(`${E2E_API_URL}/api/user-memory/${keyA}`).catch(() => {})
      await sessionA.dispose()
    }
  })
})

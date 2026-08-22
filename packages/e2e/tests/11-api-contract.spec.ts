// =============================================================================
// 11 — API contract (pure REST, no browser)
// =============================================================================
// Drives the API surface directly via Playwright's request context. Covers the
// auth/428/401 paths and the read-mostly endpoints that the dashboard consumes,
// plus a few mutations (memory CRUD, schedules CRUD, job-sources CRUD). No LLM.
import { test, expect } from "@playwright/test"
import { E2E_API_URL, USER_A, USER_NOT_ONBOARDED } from "../fixtures/env"
import { loginAs } from "../fixtures/api"

test.describe("API contract", () => {
  test("401 on protected path without session", async ({ request }) => {
    const res = await request.get(`${E2E_API_URL}/api/status`)
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toMatch(/unauthorized/i)
  })

  test("428 on protected path when not onboarded", async ({ request }) => {
    // Uses the seeded not-onboarded user. Spec 03 (which completes this
    // user's onboarding as part of its flow) restores the flag afterward —
    // if this fails with a 200, that restoration didn't run.
    const s = await loginAs(USER_NOT_ONBOARDED.email, USER_NOT_ONBOARDED.password)
    try {
      const res = await s.context.get(`${E2E_API_URL}/api/status`)
      expect(res.status()).toBe(428)
      expect((await res.json()).error).toMatch(/onboarding/i)
    } finally {
      await s.dispose()
    }
  })

  test.describe("authenticated (onboarded User A)", () => {
    // Reusable session — created once for this describe block.
    let s: Awaited<ReturnType<typeof loginAs>>

    test.beforeAll(async () => {
      s = await loginAs(USER_A.email, USER_A.password)
    })
    test.afterAll(async () => {
      await s.dispose()
    })

    // The set of GET endpoints the dashboard + pages rely on. Each must 200.
    const GET_OK: [string, string][] = [
      ["status", "/api/status"],
      ["profile", "/api/profile"],
      ["pipeline", "/api/pipeline"],
      ["runs", "/api/runs"],
      ["log", "/api/log?limit=20"],
      ["schedules", "/api/schedules"],
      ["notifications", "/api/notifications?limit=10"],
      ["user-memory", "/api/user-memory"],
      ["memory", "/api/memory"],
      ["tokens-by-day", "/api/tokens-by-day?days=7"],
      ["summaries", "/api/summaries?limit=5"],
      ["follow-ups", "/api/follow-ups"],
      ["job-sources", "/api/job-sources"],
    ]
    for (const [name, path] of GET_OK) {
      test(`GET ${name} → 200`, async () => {
        const res = await s.context.get(`${E2E_API_URL}${path}`)
        expect.soft(res.ok(), `${name} returned ${res.status()}`).toBe(true)
        // Must be JSON (these are all JSON endpoints).
        expect(res.headers()["content-type"] ?? "").toContain("application/json")
      })
    }

    test("memory PUT + GET + DELETE round-trip", async () => {
      const key = `contract_mem_${Date.now()}`
      const value = "contract value"

      const putRes = await s.context.put(`${E2E_API_URL}/api/memory`, {
        data: { key, value },
      })
      expect(putRes.ok()).toBe(true)

      const getRes = await s.context.get(`${E2E_API_URL}/api/memory`)
      const rows = await getRes.json()
      const flat = Array.isArray(rows) ? rows : rows?.entries ?? []
      expect(
        flat.some((e: any) => (e.key ?? e[0]) === key),
        "set memory key should appear in GET /api/memory",
      ).toBe(true)

      const delRes = await s.context.delete(`${E2E_API_URL}/api/memory/${key}`)
      expect(delRes.ok()).toBe(true)
    })

    test("schedules POST + GET + DELETE round-trip", async () => {
      // Use an every-hour cron — it just gets stored, never actually fires
      // during the test (the cron watchdog runs every 2 min and the harness
      // decides internally whether a run is due).
      const postRes = await s.context.post(`${E2E_API_URL}/api/schedules`, {
        data: { cron: "0 * * * *", focus: "e2e-contract" },
      })
      expect(postRes.ok(), "POST /api/schedules").toBe(true)

      const listRes = await s.context.get(`${E2E_API_URL}/api/schedules`)
      const items = await listRes.json()
      const created = (items as any[]).find((i) => i.focus === "e2e-contract")
      expect(created, "created schedule should appear in list").toBeTruthy()
      expect(created.id).toBeTruthy()

      const delRes = await s.context.delete(`${E2E_API_URL}/api/schedules/${created.id}`)
      expect(delRes.ok()).toBe(true)
    })

    test("job-sources POST + PUT + DELETE round-trip", async () => {
      // Browse-only source (no search_url_template). The optional-template
      // contract requires this round-trip to succeed without a template.
      const postRes = await s.context.post(`${E2E_API_URL}/api/job-sources`, {
        data: {
          name: "E2E Source",
          baseUrl: "https://e2e-source.test",
          notes: "created by e2e",
          enabled: true,
        },
      })
      expect(postRes.ok()).toBe(true)

      const listRes = await s.context.get(`${E2E_API_URL}/api/job-sources`)
      const items = await listRes.json()
      const created = (items as any[]).find((i: any) => i.name === "E2E Source")
      expect(created, "created job-source should appear").toBeTruthy()

      // PUT to update.
      const putRes = await s.context.put(
        `${E2E_API_URL}/api/job-sources/${created.id}`,
        {
          data: { ...created, notes: "updated by e2e" },
        },
      )
      expect(putRes.ok()).toBe(true)

      // DELETE.
      const delRes = await s.context.delete(
        `${E2E_API_URL}/api/job-sources/${created.id}`,
      )
      expect(delRes.ok()).toBe(true)
    })

    test("job status rejects invalid enum values with 400", async () => {
      const postRes = await s.context.post(`${E2E_API_URL}/api/jobs`, {
        data: {
          title: `E2E Status ${Date.now()}`,
          company: "E2E Corp",
          url: `https://example.test/status-${Date.now()}`,
        },
      })
      expect(postRes.ok()).toBe(true)
      const jobId = (await postRes.json()).id

      try {
        const badRes = await s.context.put(
          `${E2E_API_URL}/api/jobs/${jobId}/status`,
          { data: { status: "definitely-not-a-status" } },
        )
        expect(badRes.status()).toBe(400)
        expect((await badRes.json()).error).toMatch(/invalid status/i)

        // Valid value still works after the rejection.
        const goodRes = await s.context.put(
          `${E2E_API_URL}/api/jobs/${jobId}/status`,
          { data: { status: "draft" } },
        )
        expect(goodRes.ok()).toBe(true)
      } finally {
        await s.context.delete(`${E2E_API_URL}/api/jobs/${jobId}`)
      }
    })

    test("moving a job to applied auto-creates a follow-up", async () => {
      const postRes = await s.context.post(`${E2E_API_URL}/api/jobs`, {
        data: {
          title: `E2E Applied ${Date.now()}`,
          company: "E2E Corp",
          url: `https://example.test/applied-${Date.now()}`,
        },
      })
      const jobId = (await postRes.json()).id

      try {
        // First transition into applied seeds the nudge.
        const moveRes = await s.context.put(
          `${E2E_API_URL}/api/jobs/${jobId}/status`,
          { data: { status: "applied" } },
        )
        expect(moveRes.ok()).toBe(true)

        const detailRes = await s.context.get(`${E2E_API_URL}/api/jobs/${jobId}`)
        const detail = await detailRes.json()
        const open = (detail.followUps ?? []).filter((f: any) => !f.completed)
        expect(open.length).toBe(1)
        expect(open[0].note).toMatch(/follow up/i)

        // Lifecycle: complete it, then delete it.
        const putRes = await s.context.put(
          `${E2E_API_URL}/api/follow-ups/${open[0].id}`,
          { data: { completed: true } },
        )
        expect(putRes.ok()).toBe(true)

        const delRes = await s.context.delete(
          `${E2E_API_URL}/api/follow-ups/${open[0].id}`,
        )
        expect(delRes.ok()).toBe(true)

        const afterRes = await s.context.get(`${E2E_API_URL}/api/jobs/${jobId}`)
        const after = await afterRes.json()
        expect((after.followUps ?? []).length).toBe(0)
      } finally {
        await s.context.delete(`${E2E_API_URL}/api/jobs/${jobId}`)
      }
    })

    test("job detail includes cover letters + tailored CVs; editing works", async () => {
      const postRes = await s.context.post(`${E2E_API_URL}/api/jobs`, {
        data: {
          title: `E2E Detail ${Date.now()}`,
          company: "E2E Corp",
          url: `https://example.test/detail-${Date.now()}`,
          description: "A job description for contract testing.",
        },
      })
      const jobId = (await postRes.json()).id

      try {
        const getRes = await s.context.get(`${E2E_API_URL}/api/jobs/${jobId}`)
        expect(getRes.ok()).toBe(true)
        const detail = await getRes.json()
        expect(detail.listing?.id).toBe(jobId)
        expect(Array.isArray(detail.coverLetters)).toBe(true)
        expect(Array.isArray(detail.tailoredCvs)).toBe(true)
        expect(Array.isArray(detail.followUps)).toBe(true)

        // The tailored-CV document list endpoint exists (empty for a new job).
        const cvsRes = await s.context.get(
          `${E2E_API_URL}/api/jobs/${jobId}/tailored-cvs`,
        )
        expect(cvsRes.ok()).toBe(true)
        expect(await cvsRes.json()).toEqual([])

        // Notes/priority edit round-trip.
        const putRes = await s.context.put(`${E2E_API_URL}/api/jobs/${jobId}`, {
          data: { notes: "contract note", priority: 2 },
        })
        expect(putRes.ok()).toBe(true)

        const updatedRes = await s.context.get(`${E2E_API_URL}/api/jobs/${jobId}`)
        const updated = await updatedRes.json()
        expect(updated.listing?.notes).toBe("contract note")
        expect(updated.listing?.priority).toBe(2)
      } finally {
        await s.context.delete(`${E2E_API_URL}/api/jobs/${jobId}`)
      }
    })
  })
})

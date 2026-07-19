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
      const postRes = await s.context.post(`${E2E_API_URL}/api/job-sources`, {
        data: {
          name: "E2E Source",
          base_url: "https://e2e-source.test",
          search_url_template: "https://e2e-source.test/q={query}",
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
      const putRes = await s.context.put(`${E2E_API_URL}/api/job-sources/${created.id}`, {
        data: { ...created, notes: "updated by e2e" },
      })
      expect(putRes.ok()).toBe(true)

      // DELETE.
      const delRes = await s.context.delete(`${E2E_API_URL}/api/job-sources/${created.id}`)
      expect(delRes.ok()).toBe(true)
    })
  })
})

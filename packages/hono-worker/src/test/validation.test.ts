// =============================================================================
// Security-hardening unit tests (node pool — no Workers runtime needed).
// =============================================================================
// Covers the validation layer (src/utils/validation.ts) and the origin-check
// middleware (src/middleware/origin-check.ts) introduced in the audit
// remediation. Route-level behavior against a live worker is covered by
// packages/e2e/tests/12-security-hardening.spec.ts.
import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { z } from "zod"

const {
  readJsonBody,
  numericParam,
  numericQuery,
  httpUrlSchema,
  dateSchema,
  sanitizeFilename,
  isAccountDeleteConfirmed,
  ACCOUNT_DELETE_CONFIRM_PHRASE,
  configUpdateSchema,
  CONFIG_ALLOWED_KEYS,
  profilePatchSchema,
  onboardingSchema,
  planAdvanceSchema,
  jobCreateSchema,
  jobSourceCreateSchema,
  memoryPutSchema,
  browserProbeSchema,
  followUpCreateSchema,
} = await import("../utils/validation")
const { originCheck } = await import("../middleware/origin-check")

// Hono Context for helper tests — a one-route app whose handler captures `c`.
async function withContext(
  fn: (c: any) => Promise<unknown> | unknown,
  init?: RequestInit,
  query = "",
): Promise<{ c: any; response: Response }> {
  const app = new Hono()
  let captured: any
  app.post("/t" + query, async c => {
    captured = c
    return c.json({ ok: true })
  })
  const response = await app.request(
    "/t" + query,
    { method: "POST", ...init },
    {} as any,
  )
  return { c: captured, response }
}

describe("readJsonBody", () => {
  const schema = z.object({ name: z.string().min(1) })

  it("passes through valid JSON matching the schema", async () => {
    const { c } = await withContext(undefined, {
      body: JSON.stringify({ name: "abc" }),
    })
    const result = await readJsonBody(c, schema)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ name: "abc" })
  })

  it("treats an absent/empty body as {} (dashboard POSTs with no payload)", async () => {
    const { c } = await withContext(undefined, { body: "" })
    const result = await readJsonBody(c, z.object({ goal: z.string().optional() }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({})
  })

  it("returns a 400 Response for malformed JSON (previously a 500)", async () => {
    const { c } = await withContext(undefined, { body: "not json{" })
    const result = await readJsonBody(c, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      expect(await result.response.json()).toMatchObject({
        error: expect.stringContaining("valid JSON"),
      })
    }
  })

  it("returns a 400 naming the offending field on schema violation", async () => {
    const { c } = await withContext(undefined, {
      body: JSON.stringify({ name: 42 }),
    })
    const result = await readJsonBody(c, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = await result.response.json()
      expect(body.error).toContain("name")
    }
  })

  it("rejects unknown keys when allowedKeys is set, with the operator hint for llm* keys (audit C2)", async () => {
    const { c } = await withContext(undefined, {
      body: JSON.stringify({
        goal: "x",
        llmProvider: "openai-compatible",
        customProviderUrl: "https://attacker.example/v1",
      }),
    })
    const result = await readJsonBody(c, configUpdateSchema, {
      allowedKeys: CONFIG_ALLOWED_KEYS,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = await result.response.json()
      expect(body.error).toContain("llmProvider")
      expect(body.error).toContain("operator-managed")
    }
  })
})

describe("numericParam / numericQuery (audit M5 — NaN guards)", () => {
  it("numericParam accepts positive integers", async () => {
    const { c } = await withContext(undefined, {}, "")
    // Route params come from the path; simulate via a param'd app instead.
    const app = new Hono()
    app.post("/t/:id", async c => {
      const r = numericParam(c, "id")
      return c.json(r.ok ? { v: r.value } : { err: true }, r.ok ? 200 : 400)
    })
    const ok = await app.request("/t/42", { method: "POST" })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ v: 42 })

    for (const bad of ["abc", "-3", "0", "1.5"]) {
      const res = await app.request(`/t/${bad}`, { method: "POST" })
      expect(res.status, `param "${bad}" should 400`).toBe(400)
    }
  })

  it("numericQuery applies defaults and rejects out-of-range / NaN values", async () => {
    const app = new Hono()
    app.get("/t", async c => {
      const r = numericQuery(c, "limit", 50, 1, 500)
      return c.json(r.ok ? { v: r.value } : { err: true }, r.ok ? 200 : 400)
    })
    expect(await (await app.request("/t")).json()).toEqual({ v: 50 })
    expect(await (await app.request("/t?limit=")).json()).toEqual({ v: 50 })
    expect(await (await app.request("/t?limit=7")).json()).toEqual({ v: 7 })
    expect((await app.request("/t?limit=abc")).status).toBe(400)
    expect((await app.request("/t?limit=0")).status).toBe(400)
    expect((await app.request("/t?limit=501")).status).toBe(400)
    expect((await app.request("/t?limit=1e9")).status).toBe(400)
  })
})

describe("httpUrlSchema (audit H6/M4 — scheme enforcement)", () => {
  it("accepts http and https URLs", () => {
    expect(httpUrlSchema("url").safeParse("https://example.com/jobs").success).toBe(true)
    expect(httpUrlSchema("url").safeParse("http://localhost:3000").success).toBe(true)
  })

  it("rejects javascript:, data:, file:, and non-URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "not a url",
      "",
      "ftp://example.com",
    ]) {
      expect(
        httpUrlSchema("url").safeParse(bad).success,
        `"${bad}" should be rejected`,
      ).toBe(false)
    }
  })

  it("browserProbeSchema rejects javascript: URLs (the drive-my-Chrome vector)", () => {
    expect(
      browserProbeSchema.safeParse({ url: "javascript:alert(document.domain)" }).success,
    ).toBe(false)
    expect(browserProbeSchema.safeParse({ url: "https://example.com" }).success).toBe(true)
  })
})

describe("dateSchema + sanitizeFilename + account confirm (audit L3/M9)", () => {
  it("accepts real YYYY-MM-DD dates, rejects malformed/impossible ones", () => {
    expect(dateSchema.safeParse("2026-08-23").success).toBe(true)
    expect(dateSchema.safeParse("2026-13-01").success).toBe(false)
    expect(dateSchema.safeParse("23/08/2026").success).toBe(false)
    expect(dateSchema.safeParse("next tuesday").success).toBe(false)
  })

  it("followUpCreateSchema requires a valid dueDate", () => {
    expect(followUpCreateSchema.safeParse({ dueDate: "2026-09-01" }).success).toBe(true)
    expect(followUpCreateSchema.safeParse({ note: "x" }).success).toBe(false)
  })

  it("sanitizeFilename strips paths, control chars, and caps length", () => {
    expect(sanitizeFilename("../../etc/passwd", "cv")).toBe("passwd")
    expect(sanitizeFilename("C:\\Users\\x\\my cv.pdf", "cv")).toBe("my cv.pdf")
    expect(sanitizeFilename("a\u0000b<c>d|e", "cv")).toBe("a_b_c_d_e")
    expect(sanitizeFilename("", "cv")).toBe("cv")
    expect(sanitizeFilename(undefined, "cv")).toBe("cv")
    expect(sanitizeFilename("x".repeat(500), "cv").length).toBe(180)
  })

  it("account delete confirmation matches case/whitespace-insensitively", () => {
    expect(isAccountDeleteConfirmed({ confirm: "delete my account" })).toBe(true)
    expect(isAccountDeleteConfirmed({ confirm: "  Delete My Account  " })).toBe(true)
    expect(isAccountDeleteConfirmed({ confirm: "delete" })).toBe(false)
    expect(isAccountDeleteConfirmed({ confirm: "" })).toBe(false)
    expect(ACCOUNT_DELETE_CONFIRM_PHRASE).toBe("delete my account")
  })
})

describe("route body schemas", () => {
  it("configUpdateSchema coerces numeric strings and clamps via min/max (audit C2/H5)", () => {
    const r = configUpdateSchema.safeParse({ maxSteps: "42", tokenBudget: "0" })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.maxSteps).toBe(42)
      expect(r.data.tokenBudget).toBe(0)
    }
    // H5: negatives / huge values are rejected, not silently accepted.
    expect(configUpdateSchema.safeParse({ maxSteps: -5 }).success).toBe(false)
    expect(configUpdateSchema.safeParse({ maxSteps: 999999 }).success).toBe(false)
    expect(configUpdateSchema.safeParse({ tokenBudget: -1 }).success).toBe(false)
  })

  it("profilePatchSchema DROPS non-profile keys like cvR2Key (audit H4)", () => {
    const r = profilePatchSchema.safeParse({
      firstName: "Ada",
      cvR2Key: "cvs/some-other-user/uuid",
      cvText: "attacker-controlled",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).toEqual({ firstName: "Ada" })
      expect("cvR2Key" in r.data).toBe(false)
    }
  })

  it("onboardingSchema allows profile fields + the seed flag only", () => {
    const r = onboardingSchema.safeParse({
      firstName: "A",
      seedDefaultJobSources: true,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.seedDefaultJobSources).toBe(true)
    }
    // Unknown keys are STRIPPED (not stored), and over-long values are
    // rejected by the per-field cap (audit M11).
    const evil = onboardingSchema.safeParse({ evil: "x".repeat(5000) })
    expect(evil.success).toBe(true)
    if (evil.success) expect(Object.keys(evil.data)).toEqual([])
    expect(
      onboardingSchema.safeParse({ firstName: "x".repeat(2001) }).success,
    ).toBe(false)
  })

  it("planAdvanceSchema defaults status and rejects arbitrary strings (audit M6)", () => {
    const r = planAdvanceSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.status).toBe("complete")
    expect(planAdvanceSchema.safeParse({ status: "bogus" }).success).toBe(false)
  })

  it("jobCreateSchema requires company/title, allows url: null, bounds matchScore (audit M10)", () => {
    expect(
      jobCreateSchema.safeParse({ company: "Acme", title: "Eng", url: null }).success,
    ).toBe(true)
    expect(jobCreateSchema.safeParse({ title: "Eng" }).success).toBe(false)
    expect(
      jobCreateSchema.safeParse({ company: "A", title: "T", matchScore: 7 }).success,
    ).toBe(false)
    expect(
      jobCreateSchema.safeParse({ company: "A", title: "T", url: "javascript:1" }).success,
    ).toBe(false)
  })

  it("jobSourceCreateSchema enforces http(s) baseUrl (audit M10)", () => {
    expect(
      jobSourceCreateSchema.safeParse({ name: "N", baseUrl: "https://x.test" }).success,
    ).toBe(true)
    expect(
      jobSourceCreateSchema.safeParse({ name: "N", baseUrl: "javascript:alert(1)" }).success,
    ).toBe(false)
    // `enabled` is accepted (e2e contract sends it) but optional.
    expect(
      jobSourceCreateSchema.safeParse({ name: "N", baseUrl: "https://x.test", enabled: true })
        .success,
    ).toBe(true)
  })

  it("memoryPutSchema caps key/value lengths (audit M11)", () => {
    expect(memoryPutSchema.safeParse({ key: "k", value: "v" }).success).toBe(true)
    expect(memoryPutSchema.safeParse({ value: "v" }).success).toBe(false)
    expect(memoryPutSchema.safeParse({ key: "x".repeat(201) }).success).toBe(false)
    expect(memoryPutSchema.safeParse({ key: "k", value: "x".repeat(100_001) }).success).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Origin-check middleware (audit H3) — exercised through a real Hono app.
// -----------------------------------------------------------------------------

function originTestApp() {
  const app = new Hono()
  app.use("*", originCheck)
  app.post("/api/memory", c => c.json({ ok: true }))
  app.put("/api/config", c => c.json({ ok: true }))
  app.delete("/api/account", c => c.json({ ok: true }))
  app.get("/api/status", c => c.json({ ok: true }))
  app.post("/api/auth/sign-in/email", c => c.json({ ok: true }))
  app.post("/api/browser/refresh", c => c.json({ ok: true }))
  return app
}

const TEST_ENV = {
  FRONTEND_URL: "http://localhost:5173",
  BETTER_AUTH_URL: "http://localhost:8787",
} as any

describe("originCheck middleware (audit H3)", () => {
  const app = originTestApp()

  it("rejects a foreign Origin on POST/PUT/DELETE with 403", async () => {
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const res = await app.request("/api/memory", {
        method,
        headers: { origin: "https://evil.example" },
      }, TEST_ENV)
      // /api/memory only has a POST handler; PUT/DELETE 404 AFTER passing the
      // middleware — so assert against routes that exist per method.
      if (method === "POST") {
        expect(res.status, `${method} must be blocked by origin check`).toBe(403)
        expect(await res.json()).toMatchObject({ error: expect.any(String) })
      }
    }
    const put = await app.request("/api/config", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    }, TEST_ENV)
    expect(put.status).toBe(403)
    const del = await app.request("/api/account", {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    }, TEST_ENV)
    expect(del.status).toBe(403)
  })

  it("allows the frontend + API origins (trailing-slash tolerant)", async () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:5173/",
      "http://localhost:8787",
    ]) {
      const res = await app.request("/api/memory", {
        method: "POST",
        headers: { origin },
      }, TEST_ENV)
      expect(res.status, `origin ${origin} must be allowed`).toBe(200)
    }
  })

  it("allows requests with no Origin header (non-browser clients)", async () => {
    const res = await app.request("/api/memory", { method: "POST" }, TEST_ENV)
    expect(res.status).toBe(200)
  })

  it("does not apply to GET", async () => {
    const res = await app.request("/api/status", {
      headers: { origin: "https://evil.example" },
    }, TEST_ENV)
    expect(res.status).toBe(200)
  })

  it("exempts Better Auth + extension refresh endpoints (they auth themselves)", async () => {
    const auth = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: "chrome-extension://abc" },
    }, TEST_ENV)
    expect(auth.status).toBe(200)
    const refresh = await app.request("/api/browser/refresh", {
      method: "POST",
      headers: { origin: "chrome-extension://abc" },
    }, TEST_ENV)
    expect(refresh.status).toBe(200)
  })
})

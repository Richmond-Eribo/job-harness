// =============================================================================
// 12 — Security hardening (validation + CSRF + cross-tenant regressions)
// =============================================================================
// End-to-end coverage for the audit remediation (docs/validation-security-audit.md):
//   C1  /agents/* DO fallback router removed → cross-tenant 404
//   C2  PUT /api/config key-allowlisted (no llmProvider/customProviderUrl)
//   H3  origin-check on mutating routes (foreign Origin → 403)
//   H4  PUT /api/profile mass-assignment blocked (cvR2Key dropped)
//   H5  maxSteps/tokenBudget clamped
//   H6  /api/browser/probe rejects non-http(s) URLs
//   M5  NaN query/param guards → clean 400s
//   M6  plan advance status enum
//   M8  security headers present
//   M9  account delete requires server-side typed confirmation
// Plus regression checks that the normal flows the dashboard depends on still
// work (memory CRUD, schedules CRUD, config goal/maxSteps update) — the
// "no broken changes" contract.
import { test, expect } from "../fixtures/auth"
import {
  E2E_API_URL,
  E2E_WEB_URL,
  USER_A,
  uniqEmail,
  E2E_OTP_FOR,
  E2E_PASSWORD,
} from "../fixtures/env"
import { loginAs } from "../fixtures/api"

test.describe("security hardening", () => {
  let s: Awaited<ReturnType<typeof loginAs>>

  test.beforeAll(async () => {
    s = await loginAs(USER_A.email, USER_A.password)
  })
  test.afterAll(async () => {
    await s.dispose()
  })

  // ── C1: the agents-SDK fallback router must be gone ──────────────────────
  test("C1: /agents/* DO routes 404 even when authenticated", async () => {
    // Previously ANY authenticated user could reach ANY other user's
    // Durable Objects (e.g. hijack their browser-relay WebSocket).
    const http = await s.context.get(`${E2E_API_URL}/agents/harness/some-other-user`)
    expect(http.status()).toBe(404)

    const ws = await s.context.fetch(`${E2E_API_URL}/agents/browser-relay/some-other-user`, {
      headers: { Upgrade: "websocket", "Connection": "Upgrade" },
    })
    expect(ws.status()).toBe(404)
  })

  // ── C2 + H5: config lockdown ─────────────────────────────────────────────
  test("C2: PUT /api/config rejects model/provider keys with the operator hint", async () => {
    const res = await s.context.put(`${E2E_API_URL}/api/config`, {
      data: {
        llmProvider: "openai-compatible",
        llmModel: "attacker-model",
        customProviderUrl: "https://attacker.example/v1",
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("operator-managed")
    expect(body.error).toContain("customProviderUrl")
  })

  test("C2: PUT /api/config rejects arbitrary unknown keys", async () => {
    const res = await s.context.put(`${E2E_API_URL}/api/config`, {
      data: { sneakyKey: "1; DROP TABLE config" },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toContain("sneakyKey")
  })

  test("H5: maxSteps/tokenBudget reject out-of-range values", async () => {
    for (const bad of [{ maxSteps: -5 }, { maxSteps: 999999 }, { tokenBudget: -1 }]) {
      const res = await s.context.put(`${E2E_API_URL}/api/config`, { data: bad })
      expect(res.status(), JSON.stringify(bad)).toBe(400)
    }
  })

  test("regression: config goal + clamped maxSteps still round-trip", async () => {
    const put = await s.context.put(`${E2E_API_URL}/api/config`, {
      data: { maxSteps: 42, goal: "e2e security spec goal" },
    })
    expect(put.ok()).toBe(true)

    const get = await s.context.get(`${E2E_API_URL}/api/config`)
    expect(get.ok()).toBe(true)
    const cfg = await get.json()
    expect(String(cfg.maxSteps)).toBe("42")
    expect(cfg.goal).toContain("e2e security spec goal")

    // Restore the default so other specs aren't affected.
    await s.context.put(`${E2E_API_URL}/api/config`, {
      data: { maxSteps: 100 },
    })
  })

  // ── H3: origin check on mutating routes ──────────────────────────────────
  test("H3: foreign-Origin mutating request is 403, allowed origin passes", async () => {
    // A cross-site browser form can fire a simple POST with the victim's
    // SameSite=None cookie — the origin check must block it before routing.
    const evil = await s.context.post(`${E2E_API_URL}/api/memory`, {
      headers: { Origin: "https://evil.example" },
      data: { key: "csrf-key", value: "should never be written" },
    })
    expect(evil.status()).toBe(403)

    // The memory key must NOT have been written (the cookie rode along, but
    // the origin check fired before the handler).
    const list = await s.context.get(`${E2E_API_URL}/api/memory`)
    const rows = await list.json()
    const flat = Array.isArray(rows) ? rows : rows?.entries ?? []
    expect(flat.some((e: any) => e.key === "csrf-key")).toBe(false)

    // The frontend origin is allowed… (memory writes are PUT)
    const ok = await s.context.put(`${E2E_API_URL}/api/memory`, {
      headers: { Origin: E2E_WEB_URL },
      data: { key: "csrf-key", value: "written by allowed origin" },
    })
    expect(ok.status()).toBe(200)
    // …and no-Origin (server-to-server / CLI) requests pass too.
    const noOrigin = await s.context.put(`${E2E_API_URL}/api/memory`, {
      data: { key: "csrf-key-2", value: "no origin header" },
    })
    expect(noOrigin.status()).toBe(200)

    await s.context.delete(`${E2E_API_URL}/api/memory/csrf-key`)
    await s.context.delete(`${E2E_API_URL}/api/memory/csrf-key-2`)
  })

  // ── H4: profile mass assignment ──────────────────────────────────────────
  test("H4: PUT /api/profile drops non-profile keys (cvR2Key)", async () => {
    const before = await (await s.context.get(`${E2E_API_URL}/api/profile`)).json()

    const res = await s.context.put(`${E2E_API_URL}/api/profile`, {
      data: {
        firstName: "E2ESec",
        cvR2Key: "cvs/some-other-user/not-our-key",
        cvText: "attacker-controlled CV text",
      },
    })
    expect(res.ok()).toBe(true)

    const after = await (await s.context.get(`${E2E_API_URL}/api/profile`)).json()
    expect(after.cvR2Key).toBe(before.cvR2Key ?? null)
    expect(after.cvText).toBe(before.cvText ?? null)
    expect(after.firstName).toBe("E2ESec")

    // Restore the original first name.
    await s.context.put(`${E2E_API_URL}/api/profile`, {
      data: { firstName: before.firstName ?? "" },
    })
  })

  // ── H6: probe URL scheme validation ──────────────────────────────────────
  test("H6: /api/browser/probe rejects non-http(s) URLs", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      const res = await s.context.post(`${E2E_API_URL}/api/browser/probe`, {
        data: { url },
      })
      expect(res.status(), `url "${url}"`).toBe(400)
    }
  })

  // ── M5 + M6: numeric guards + plan enum ──────────────────────────────────
  test("M5: NaN query params and non-numeric :id values return clean 400s", async () => {
    const q = await s.context.get(`${E2E_API_URL}/api/log?limit=abc`)
    expect(q.status()).toBe(400)

    const id = await s.context.put(`${E2E_API_URL}/api/schedules/abc/toggle`, {
      data: { enabled: true },
    })
    expect(id.status()).toBe(400)
  })

  test("M6: plan advance rejects arbitrary status strings", async () => {
    const res = await s.context.post(`${E2E_API_URL}/api/plan/advance`, {
      data: { status: "definitely-not-a-status" },
    })
    expect(res.status()).toBe(400)
    // Valid status still accepted (plan may be null — that's fine).
    const okRes = await s.context.post(`${E2E_API_URL}/api/plan/advance`, {
      data: { status: "skipped" },
    })
    expect(okRes.status()).toBe(200)
  })

  // ── M8: security headers ─────────────────────────────────────────────────
  test("M8: API responses carry baseline security headers", async () => {
    const res = await s.context.get(`${E2E_API_URL}/api/status`)
    expect(res.ok()).toBe(true)
    expect((res.headers()["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff")
  })

  // ── M9: account delete confirmation ──────────────────────────────────────
  test("M9: DELETE /api/account without the typed phrase is a 400 and deletes nothing", async () => {
    const res = await s.context.delete(`${E2E_API_URL}/api/account`)
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toContain("delete my account")

    // The account is still alive.
    const status = await s.context.get(`${E2E_API_URL}/api/status`)
    expect(status.ok()).toBe(true)
  })

  test("M9 (full cycle): signup → verify → delete WITH confirmation works end-to-end", async ({
    request,
  }) => {
    const email = uniqEmail("sec-del")
    const api = (path: string) => `${E2E_API_URL}${path}`

    // 1. Sign up via the real endpoint (same as the UI).
    const signup = await request.post(api("/api/auth/sign-up/email"), {
      data: { email, password: E2E_PASSWORD, name: "Security Delete Flow" },
    })
    expect(signup.ok(), `signup: ${signup.status()} ${await signup.text()}`).toBe(true)

    // 2. Mint + send the OTP (local dev: deterministic 999999 via the
    //    E2E_OTP_BYPASS + IS_LOCAL_DEV co-gate — audit M1).
    const otpSend = await request.post(api("/api/auth/email-otp/send-verification-otp"), {
      data: { email, type: "email-verification" },
    })
    // A delivery failure to the reserved example.test domain is tolerable
    // (the UI tolerates it too) — the deterministic code still verifies.
    if (!otpSend.ok()) {
      console.warn(`[spec-12] otp send returned ${otpSend.status()} (tolerated)`)
    }

    // 3. Verify the email — autoSignInAfterVerification sets the session
    //    cookie in this context's jar.
    const verify = await request.post(api("/api/auth/email-otp/verify-email"), {
      data: { email, otp: await E2E_OTP_FOR(email) },
    })
    expect(verify.ok(), `verify-email: ${verify.status()} ${await verify.text()}`).toBe(true)

    // 3.5. Complete onboarding exactly like the wizard does — fresh signups
    // stay onboardingComplete=0 (428 on everything else) until
    // POST /api/onboarding runs.
    const onboard = await request.post(api("/api/onboarding"), {
      data: { firstName: "Security", lastName: "DeleteFlow" },
    })
    expect(onboard.ok(), `onboarding: ${onboard.status()} ${await onboard.text()}`).toBe(true)

    // 4. Delete WITH the typed phrase → succeeds.
    const del = await request.delete(api("/api/account"), {
      data: { confirm: "delete my account" },
    })
    expect(del.ok(), `confirmed delete: ${del.status()} ${await del.text()}`).toBe(true)
    expect((await del.json()).deleted).toBe(true)

    // 5. Credentials no longer sign in.
    const resign = await request.post(api("/api/auth/sign-in/email"), {
      data: { email, password: E2E_PASSWORD },
    })
    expect(resign.ok()).toBe(false)
  })

  // ── UI regression: the LLM tab is read-only now ───────────────────────────
  test("UI: Settings → LLM Config shows read-only model info (no editable inputs)", async ({
    userAPage: page,
  }) => {
    await page.goto(`${E2E_WEB_URL}/settings`)
    await page.getByRole("tab", { name: /llm config/i }).click()

    await expect(page.getByText("Model Selection")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Provider", { exact: true }).first()).toBeVisible()
    // The editable provider/model/URL inputs are gone (audit C2).
    await expect(page.locator("#llmProvider")).toHaveCount(0)
    await expect(page.locator("#llmModel")).toHaveCount(0)
    await expect(page.locator("#customProviderUrl")).toHaveCount(0)
  })
})

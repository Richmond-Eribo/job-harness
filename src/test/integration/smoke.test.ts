// Smoke test for the workers integration pool.
//
// NOTE: currently SKIPPED at the config level — see vitest.workers.config.ts
// (KNOWN BLOCKER) and ./README.md. The pool boots and bindings resolve, but
// worker instantiation trips cloudflare/workers-sdk#6591 (spaces in the repo
// path + extensionless CJS requires in the agent runtime dependency tree).
//
// `npm run test:integration` will fail on this file until the blocker is
// resolved; `npm run test:unit` (the node pool) is unaffected.
import { describe, it, expect } from "vitest"
import { SELF, env } from "cloudflare:test"

describe("workers pool smoke", () => {
  it("exposes the D1 binding", () => {
    expect(env.DB).toBeDefined()
  })

  it("exposes the R2 binding", () => {
    expect(env.CV_BUCKET).toBeDefined()
  })

  it("serves a public route through the real worker (no session)", async () => {
    // /login is in PUBLIC_PREFIXES (require-auth.ts) — no session required.
    const res = await SELF.fetch("http://localhost:8787/login")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<form")
  })
})

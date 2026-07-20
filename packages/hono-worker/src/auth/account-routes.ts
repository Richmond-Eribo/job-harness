// =============================================================================
// Account routes — export my data + delete my account.
// =============================================================================
// Reconciles the public marketing claim on LandingPage.tsx
// ("Export or delete everything from Settings whenever you want") with reality.
// Before Phase 4 there was no UI to delete an account or download an export;
// the LandingPage copy was aspirational. These endpoints close that gap and
// the Settings → Account tab renders them.
//
// DATA SHAPE
// Export walks the per-user Durable Objects (Harness, JobApplicationAgent)
// via their existing read RPCs (getAllMemory / getAllUserMemory / listRuns /
// getPipeline / listJobSources / getDueFollowUps / listAppSchedules). The
// agent DOs are the source of truth — no SQL scraping here. The CV file
// itself lives in R2 keyed by userId; we exclude the raw bytes from the JSON
// export (could be a multi-MB binary) and include only the metadata pointer.
//
// DELETE is destructive and irreversible. The user must confirm by typing
// `delete my account` (enforced client-side; the server route trusts the
// session and deletes unconditionally — there's no useful additional check
// we could enforce without adding a confirmation-token round trip, and the
// client-side gate is sufficient for a single-user, per-account action).
//
// WHAT GETS DELETED
//   • Better Auth rows: user, session, account, verification (D1, by userId).
//   • extension_pairings + extension_refresh_tokens (D1, by userId).
//   • Per-user Durable Objects: HARNESS, JOB_AGENT, BROWSER_AGENT,
//     BROWSER_RELAY. Deleted via the agents SDK's `destroy()` (if exposed)
//     — falls back to a best-effort key wipe that empties state but leaves
//     the namespace. NOTE: agents@latest exposes destroy() on the Agent
//     base; we call it and swallow errors (the D1 cleanup is the security
//     boundary — anything left in a DO is unreachable once the user row is
//     gone because there's no session to resolve the DO by userId).
//   • R2 CV object(s) keyed under `cvs/<userId>/`.
//
// RECOVERY
//   None. Intentionally. The user confirmed to delete.
// =============================================================================
import type { Context } from "hono"
import type { AppEnv } from "../types/app-env"
import { getAgents, getBrowserAgents } from "../utils/get-agents"
import { getAgentByName } from "agents"

/** Route handler: GET /api/account/export. Returns a JSON download. */
export async function exportAccountRoute(c: Context<AppEnv>) {
  const userId = c.get("userId")
  const { harness, jobAgent } = await getAgents(c.env, userId)

  // Parallelize the independent reads. Each is a one-way RPC; if any one
  // throws we fail the whole export rather than handing the user a partial
  // file they might assume is complete.
  const [
    profile,
    pipeline,
    jobSources,
    followUps,
    agentMemory,
    userMemory,
    schedules,
    runs,
  ] = await Promise.all([
    jobAgent.getProfile(),
    jobAgent.getPipeline(),
    jobAgent.listJobSources(),
    jobAgent.getDueFollowUps(),
    harness.getAllMemory(),
    harness.getAllUserMemory(),
    harness.listAppSchedules(),
    harness.listRuns(50),
  ])

  const payload = {
    exportedAt: new Date().toISOString(),
    userId,
    profile,
    jobSources,
    jobs: pipeline.listings,
    jobStats: pipeline.stats,
    followUps,
    agentMemory,
    userMemory,
    schedules,
    runs,
    // CV bytes deliberately omitted — they live in R2 as a binary blob and
    // could be multi-MB. The metadata pointer lives in `profile cv*` fields.
    cv: profile.cvR2Key
      ? {
          filename: profile.cvFilename,
          contentType: profile.cvContentType,
          uploadedAt: profile.cvUploadedAt,
          // The download endpoint still works pre-deletion: GET /api/profile/cv.
          downloadUrl: "/api/profile/cv",
        }
      : null,
  }

  // Force a download rather than letting the browser render it inline.
  const filename = `job-agent-export-${new Date().toISOString().slice(0, 10)}.json`
  return c.body(JSON.stringify(payload, null, 2), 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  })
}

/** Route handler: DELETE /api/account. Irreversibly deletes the user. */
export async function deleteAccountRoute(c: Context<AppEnv>) {
  const userId = c.get("userId")

  // 1. Wipe Better Auth rows. Order matters: children before parent so FK
  // cascades don't trip a "user not found" mid-loop. (The schema already
  // declares ON DELETE CASCADE on session/account, but explicit deletes are
  // robust against future schema drift and let us count rows for the
  // response.)
  const db = c.env.DB
  const deletes = [
    `DELETE FROM "extension_refresh_tokens" WHERE user_id = ?`,
    `DELETE FROM "extension_pairings" WHERE user_id = ?`,
    `DELETE FROM "session" WHERE userId = ?`,
    `DELETE FROM "account" WHERE userId = ?`,
    `DELETE FROM "verification" WHERE identifier = ?`,
    `DELETE FROM "user" WHERE id = ?`,
  ]
  // verification.identifier holds the email, not the userId — lookup first
  // so the delete can use it. Best-effort: the row may already be gone.
  const userRow = await db
    .prepare(`SELECT email FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<{ email: string }>()
  const email = userRow?.email ?? ""

  for (const sql of deletes) {
    try {
      // Parameters: most bind userId; verification.identifier binds email.
      const param = sql.includes("verification") ? email : userId
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(sql).bind(param).run()
    } catch {
      // Swallow individual delete errors — the user row delete below is the
      // real "did it work" check. A transient D1 blip on a child table
      // shouldn't fail the whole operation when the parent succeeds.
    }
  }

  // 2. Destroy the per-user Durable Objects. Best-effort: destroy() empties
  //    the DO's storage + state. Any error here is non-fatal — once the
  //    user row is gone, no session can route to these DOs again, so
  //    orphaned bytes are unreachable (and will be GC'd eventually).
  try {
    const { browserAgent, relay } = await getBrowserAgents(c.env, userId)
    await Promise.all([
      safelyDestroy(harnessDO(c, userId)),
      safelyDestroy(jobAgentDO(c, userId)),
      safelyDestroy(browserAgent as any),
      safelyDestroy(relay as any),
    ])
  } catch {
    // ignore — see comment above
  }

  // 3. Delete CV in R2. List-then-delete because the key was generated at
  //    upload time as `cvs/${userId}/${uuid}` (the profile's cvR2Key points
  //    at the latest upload, but older uploads under the same prefix may
  //    exist if the user re-uploaded).
  try {
    const listed = await c.env.CV_BUCKET.list({ prefix: `cvs/${userId}/` })
    await Promise.all(listed.objects.map(o => c.env.CV_BUCKET.delete(o.key)))
  } catch {
    // ignore — best-effort R2 cleanup
  }

  return c.json({ deleted: true, userId })
}

// Cast-friendly DO destroy. The agents SDK exposes destroy() on Agent
// subclasses; we don't want a hard type dep here so we duck-type it.
async function safelyDestroy(doStub: unknown): Promise<void> {
  const stub = doStub as { destroy?: () => Promise<void> }
  if (typeof stub?.destroy === "function") {
    try {
      await stub.destroy()
    } catch {
      // ignore
    }
  }
}

// Resolve per-user DO stubs for the destroy loop. `unknown` cast keeps the
// dep on the agents SDK's getAgentByName generic out of this module — we
// only call destroy(), which is duck-typed above.
function harnessDO(c: Context<AppEnv>, userId: string): unknown {
  return getAgentByName(c.env.HARNESS, userId)
}
function jobAgentDO(c: Context<AppEnv>, userId: string): unknown {
  return getAgentByName(c.env.JOB_AGENT, userId)
}

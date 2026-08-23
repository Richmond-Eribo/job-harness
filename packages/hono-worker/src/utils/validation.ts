// =============================================================================
// validation — shared request-input helpers + route body schemas.
// =============================================================================
// AUDIT (H1/M5/M6/M10/M11/L5): before this module, no HTTP route used a
// validation schema — every route consumed raw `c.req.json()` with at best a
// one-field typeof check. These helpers make every route:
//   • reject malformed JSON with a clean 400 (PUT routes previously threw 500),
//   • reject wrong-shaped/oversized/out-of-range fields with a 400 that names
//     the offending field,
//   • parse numeric path/query params with Number.isFinite guards (NaN values
//     previously flowed into DO RPCs and SQL LIMITs).
//
// zod is already a dependency (the LLM tool layer uses it); these schemas are
// the HTTP-side counterpart. Deliberately NODE-POOL TESTABLE: no imports from
// the DO/agent code — src/test/validation.test.ts covers every helper.
// =============================================================================
import type { Context } from "hono"
import { z } from "zod"

export type BodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response }

export type ParamResult =
  | { ok: true; value: number }
  | { ok: false; response: Response }

function zodDetail(error: z.ZodError): string {
  return error.issues
    .map(i => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ")
}

/**
 * Parse + schema-validate a JSON request body. Returns a 400 Response on
 * malformed JSON or schema violation — never throws, so routes can early-
 * return without try/catch:
 *
 *   const parsed = await readJsonBody(c, schema)
 *   if (!parsed.ok) return parsed.response
 */
export async function readJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  opts?: { allowedKeys?: readonly string[] },
): Promise<BodyResult<T>> {
  let raw: unknown
  try {
    const text = await c.req.text()
    // An absent body (dashboard POSTs with no payload, curl, future callers)
    // is treated as {} — same tolerance the old `.catch(() => ({}))` routes
    // had. Only MALFORMED JSON is a client error.
    raw = text.trim() === "" ? {} : JSON.parse(text)
  } catch {
    return {
      ok: false,
      response: c.json({ error: "Request body must be valid JSON" }, 400),
    }
  }

  if (opts?.allowedKeys && raw && typeof raw === "object" && !Array.isArray(raw)) {
    const allowed = new Set(opts.allowedKeys)
    const rejected = Object.keys(raw as Record<string, unknown>).filter(
      k => !allowed.has(k),
    )
    if (rejected.length > 0) {
      // Point operators at the right knob when they try to mutate the
      // model/provider through the user-facing config route (audit C2).
      const llmKeys = rejected.filter(k => k.startsWith("llm") || k === "customProviderUrl")
      const hint =
        llmKeys.length > 0
          ? ` Model/provider settings (${llmKeys.join(", ")}) are operator-managed — configure src/config/llm-config.json and redeploy.`
          : ""
      return {
        ok: false,
        response: c.json(
          {
            error: `Unknown config key(s): ${rejected.join(", ")}. Allowed: ${opts.allowedKeys.join(", ")}.${hint}`,
          },
          400,
        ),
      }
    }
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return {
      ok: false,
      response: c.json(
        { error: `Invalid request body — ${zodDetail(result.error)}` },
        400,
      ),
    }
  }
  return { ok: true, data: result.data }
}

/**
 * Parse a numeric `:id` path param. Rejects NaN / non-integer / < 1 with a 400
 * (audit M5: bare `Number(param)` previously forwarded NaN into DO RPCs).
 */
export function numericParam(c: Context, name: string): ParamResult {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      response: c.json({ error: `Invalid ${name} "${c.req.param(name)}"` }, 400),
    }
  }
  return { ok: true, value: n }
}

/**
 * Parse an integer query param with a default + hard clamp range. Rejects
 * non-numeric values with a 400 instead of letting NaN reach SQL LIMITs.
 */
export function numericQuery(
  c: Context,
  name: string,
  def: number,
  min: number,
  max: number,
): ParamResult {
  const raw = c.req.query(name)
  if (raw === undefined || raw === "") return { ok: true, value: def }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) {
    return {
      ok: false,
      response: c.json(
        {
          error: `Invalid "${name}" query param (expected an integer between ${min} and ${max})`,
        },
        400,
      ),
    }
  }
  return { ok: true, value: Math.trunc(n) }
}

// -----------------------------------------------------------------------------
// Reusable field schemas
// -----------------------------------------------------------------------------

/**
 * Absolute http(s) URL, trimmed + length-capped. `new URL()` accepts schemes
 * like javascript:/data:/file: — this refinement is the guard the browser
 * tools and probe route were missing (audit H6/M4).
 */
export function httpUrlSchema(field: string) {
  return z
    .string()
    .trim()
    .min(1, `${field} is required`)
    .max(2000, `${field} is too long`)
    .refine(
      v => {
        try {
          const proto = new URL(v).protocol
          return proto === "https:" || proto === "http:"
        } catch {
          return false
        }
      },
      { message: `${field} must be a valid http(s) URL` },
    )
}

/** Calendar date exactly as the app stores/compares it (SQLite date('now')). */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date")
  .refine(v => !Number.isNaN(Date.parse(v)), "not a real calendar date")

/**
 * Sanitize a client-supplied filename: strip any path components, remove
 * control/separator characters, cap the length (audit L3 — `?filename=` was
 * stored + echoed back unvalidated and unbounded).
 */
export function sanitizeFilename(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback
  const base = raw.split(/[\\/]/).pop() ?? ""
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
  return cleaned.length > 0 ? cleaned : fallback
}

// -----------------------------------------------------------------------------
// Route body schemas
// -----------------------------------------------------------------------------

/** Fields a client may write into the user_profile kv table (audit H4). */
export const PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "location",
  "links",
  "workAuth",
  "seniority",
  "yearsExperience",
  "targetRoles",
  "targetLocations",
  "skills",
  "preferences",
  "workMode",
  "jobSearchStatus",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
] as const

const profileFieldShape: Record<string, z.ZodOptional<z.ZodString>> = {}
for (const f of PROFILE_FIELDS) {
  profileFieldShape[f] = z.string().max(2000).optional()
}
/** Strictly-allowlisted profile patch — unknown keys (e.g. cvR2Key) are dropped. */
export const profilePatchSchema = z.object(profileFieldShape)

/** PUT /api/config — the ONLY user-mutable config keys (audit C2/H5). */
export const CONFIG_ALLOWED_KEYS = ["goal", "maxSteps", "tokenBudget"] as const

export const configUpdateSchema = z.object({
  goal: z.string().max(4000).optional(),
  // coerce keeps the frontend's string inputs ("100") working.
  maxSteps: z.coerce.number().int().min(1).max(1000).optional(),
  tokenBudget: z.coerce.number().int().min(0).max(50_000_000).optional(),
})

/** POST /api/start — goal only; `force` is accepted for back-compat, no-op. */
export const startRunSchema = z.object({
  goal: z.string().max(4000).optional(),
  force: z.boolean().optional(),
})

export const scheduleCreateSchema = z.object({
  cron: z.string().trim().min(1, "cron is required").max(120),
  focus: z.string().max(200).optional(),
})

export const scheduleToggleSchema = z.object({
  enabled: z.boolean({ message: "enabled must be a boolean" }),
})

export const memoryPutSchema = z.object({
  key: z.string().trim().min(1, "key is required").max(200),
  value: z.string().max(100_000).optional(),
})

export const goalPutSchema = z.object({
  goal: z.string().min(1, "goal is required").max(4000),
})

export const planAdvanceSchema = z.object({
  stepId: z.string().max(200).nullable().optional(),
  status: z.enum(["complete", "failed", "skipped"]).default("complete"),
  result: z.string().max(4000).nullable().optional(),
})

export const jobCreateSchema = z.object({
  company: z.string().trim().min(1, "company is required").max(300),
  title: z.string().trim().min(1, "title is required").max(300),
  description: z.string().max(8000).optional(),
  url: z.union([httpUrlSchema("url"), z.null()]).optional(),
  source: z.string().max(200).optional(),
  matchScore: z.number().min(0).max(1).optional(),
})

export const jobUpdateSchema = z.object({
  notes: z.string().max(10_000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
})

export const jobStatusSchema = z.object({
  // Route-level enum guard below keeps the exact "Invalid status" message the
  // e2e suite matches on; this schema bounds the optional notes field.
  status: z.string().min(1).max(50),
  notes: z.string().max(10_000).optional(),
})

const jobSourceUrl = httpUrlSchema("baseUrl")

export const jobSourceCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  baseUrl: jobSourceUrl,
  searchUrlTemplate: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Accepted (the e2e contract sends it) but ignored on create, matching the
  // previous behavior — sources are created enabled by default.
  enabled: z.boolean().optional(),
})

export const jobSourceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  baseUrl: jobSourceUrl.optional(),
  searchUrlTemplate: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
})

export const followUpCreateSchema = z.object({
  dueDate: dateSchema,
  note: z.string().max(2000).optional(),
})

export const followUpUpdateSchema = z.object({
  completed: z.boolean().optional(),
  dueDate: dateSchema.optional(),
  note: z.string().max(2000).optional(),
})

export const browserProbeSchema = z.object({
  url: httpUrlSchema("url"),
})

export const onboardingSchema = profilePatchSchema.extend({
  seedDefaultJobSources: z.boolean().optional(),
})

/** DELETE /api/account — the typed-phrase confirmation the UI already collects
 *  (audit M9: it was client-side only). */
export const ACCOUNT_DELETE_CONFIRM_PHRASE = "delete my account"

export const accountDeleteSchema = z.object({
  confirm: z.string({
    message: `confirmation required — send {"confirm": "${ACCOUNT_DELETE_CONFIRM_PHRASE}"}`,
  }).max(200),
})

/** Case/whitespace-insensitive phrase match (mirrors the UI's own gate). */
export function isAccountDeleteConfirmed(body: { confirm: string }): boolean {
  return body.confirm.trim().toLowerCase() === ACCOUNT_DELETE_CONFIRM_PHRASE
}

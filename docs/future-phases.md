# Future Phases

Planned logic/feature phases, distinct from the UI work. Captured here so the
decisions aren't lost between sessions.

---

## Phase L-1 — CV → Markdown parsing (so the agent reads the actual CV)

### The problem this solves
When a user uploads a CV, the worker stores the **bytes** in R2 (`CV_BUCKET`,
keyed `cvs/${userId}/${uuid}`) and writes a small JSON **pointer** into the
user profile:

```json
{ "r2Key": "cvs/abc/…", "filename": "resume.pdf", "contentType": "application/pdf" }
```

The job-search agent consumes the whole profile as one flat text blob via
`getProfileString` (`packages/hono-worker/src/agents/job-agent.ts`). So what the
LLM literally sees for the CV field today is that JSON pointer string — it tells
the model a file *exists* but gives it none of the content. That's prompt noise,
not signal: the cover-letter generator can't reference the candidate's actual
experience, and the match scorer can't weigh it.

### Goal
Parse uploaded CV bytes (PDF/DOCX/PPTX, optionally images) into markdown text
at upload time, store it in a new `cvText` profile field, and optionally a
condensed `cvSummary` memory entry. The agent then reads the real content via
the existing profile-injection path — zero change to the agent loop.

### Tool
**Microsoft `markitdown`** — converts PDF/DOCX/PPTX/XLS/images/etc. to markdown
in one call. Options:
- `@microsoft/markitdown` (JS/TS binding) if it's Workers/edge-compatible.
- The Python `markitdown` package via a Cloudflare Container (paid plan) if a
  JS binding isn't available — markitdown's richest support is Python.
- **Fallback if neither fits the free-tier Worker:** `unpdf` (Workers-native
  PDF text extraction) for PDF-only coverage; DOCX would need a separate path.

Decide the integration path during the phase — the choice depends on which
markitdown builds run under `nodejs_compat` without a Python runtime.

### Touchpoints (logic phase)
1. **`POST /api/profile/cv`** (`packages/hono-worker/src/index.ts`): after the
   R2 upload succeeds, fetch the bytes back (or parse in-flight), run markitdown,
   and store the markdown as `cvText` via `setProfile({ cvText })`. Keep the
   existing `cv`/`cvR2Key`/`cvFilename`/`cvContentType`/`cvUploadedAt` pointer
   fields (the download endpoint and Settings UI still need them).
2. **`UserProfile` type** (`packages/shared-types/src/job.ts`): add
   `cvText: string | null`.
3. **`getProfile` defaults** (`packages/hono-worker/src/agents/job-agent.ts`):
   add `cvText: null` to the defaults map (the 3-place edit — without this,
   reads silently drop it).
4. **Cover-letter / search prompts:** no change — `getProfileString` already
   concatenates the whole kv table, so `cvText` flows in automatically.
5. **Optional:** if CVs are long (token cost), summarize into a `cvSummary`
   entry in the agent's `memory` table instead of (or alongside) `cvText`.
6. **Settings UI:** surface `cvText` read-only (or just show "parsed" status) —
   the user shouldn't edit raw parsed markdown.

### Why deferred
Binary parsing in a Worker is runtime/logic work (and markitdown may need a
Python runtime via Containers). It belongs with the other logic phases, not the
UI pass.

---

## Phase L-2 — Dashboard feature pages (deferred from the UI pass)

Backend endpoints with hooks/types but no dedicated UI yet (the UI pass only
**restyled** existing pages; these are net-new surfaces):
- **Job Detail + Cover Letter** (`/jobs/$id`) — consumes `/api/jobs/:id` and
  `/api/jobs/:id/cover-letter`. Types (`CoverLetter`, `CoverLetterResponse`)
  already imported; zero UI today.
- **Schedules manager** — `/api/schedules` (the `useSchedules` hook exists but
  is unused).
- **Job-sources manager** — `/api/job-sources` (the agent's allowlist).
- **Goal + Plan editor** — `/api/goal`, `/api/plan`, `/api/plan/advance`.
- **Daily summaries view** — `/api/summaries`.
- **Browser session controls** — `/api/browser/*` (extension relay status,
  connect/disconnect, probe).
- **Run pause/resume** — `/api/pause`, `/api/resume` buttons on the Overview.

### Why deferred
These are feature work (new routes, new data flows), not the restyle. Build
them as their own focused sessions once the UI foundation is settled.

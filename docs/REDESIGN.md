# Harness Redesign — v2 Plan (2026-07-10)

This document records the design decisions reached through grilling + the
concrete changes being implemented. It supersedes the ad-hoc v1 structure
for everything it touches.

## Locked decisions (see /memories/session/resolved-design.md for full reasoning)

1. **Session = one append-only event log per harness.** No subagents, no
   multi-session model. The LLM never chooses a sessionId. The harness reads
   its own log on wake.
2. **Job grounding = fetch-rank-persist INSIDE the `discover_jobs` tool.**
   The model never calls `create_job` directly. The fetch/reason split that
   prevents hallucinated jobs comes from the existing JobAgent code and is
   preserved verbatim, just moved into a tool the single harness exposes.
3. **sendmail = HARD GATE.** Returns `{status:"needs_approval", id}`. A
   `pending_mails` table holds the queue. Human must RPC `approveMail(id)`
   before any mail actually leaves. This resists prompt-injection sending
   to arbitrary recipients.
4. **Browser = wrap in `keepAliveWhile`.** Extraction + truncation to
   ~25k tokens happens INSIDE the tool; raw HTML never enters model context.
5. **Chat vs cron = separate entrypoints, shared session.** `wake()` →
   autonomous `runLoop`. `onMessage` → single-turn streamed reply. Both
   append to the same session log.
6. **wake() contract = read `status + lastRunAt + schedules`.** If
   `status ∈ {idle, error}` and a schedule window was missed since
   lastRunAt → runLoop. Status alone is racy.
7. **MCP = OUT of v1.** Hand-built tools only.
8. **Math = nothing.** Models do arithmetic well enough; no `compute()` tool.

## What changes in this pass

### Phase 1 (this PR) — visibility + correctness, low risk

These are the things blocking trust in the dashboard and the cheapest
harness-level fixes.

1. **Dashboard CSS variable reconciliation.** The CSS was rewritten with a
   new telemetry palette (`--rule`, `--muted`, `--muted-2`, `--accent`...)
   but `dashboard.js` still references the old names (`--border`,
   `--text-muted`, `--accent-blue`). They resolve to *nothing* and the
   dashboard renders unstyled in those spots. Fix: rewrite `dashboard.js`
   against the new palette; remove all broken `var(--old-name)` references.

2. **Markdown rendering for LLM output.** Summaries, findings, job notes,
   tool inputs/outputs are all natural language coming from the model.
   Currently dumped as raw `textContent`, so `**bold**`, lists, and code
   fences render as literal characters. Fix: ship a tiny (~3KB) fenced
   markdown renderer in `public/js/markdown.js` and route every LLM-string
   field through `md.render(...)`.

3. **JSON pretty-printing for tool I/O.** Tool results are JSON strings.
   Currently they're either truncated to one line or shown raw. Fix: a
   `renderJson(str)` helper in the client that pretty-prints and
   syntax-highlights valid JSON, falls back to `<pre>` for invalid.

4. **Hardening the summaries / findings / log rendering.** Right now the
   summaries card shows raw `[stop_reason: ..., tokens: ...]` markers and
   the LLM's prose is one grey paragraph. Fix: a cleaner `<article>` layout
   with parsed "stop reason" chips, tabular tokens, and the summary body
   rendered as markdown.

5. **wrap `runLoop` in `keepAliveWhile`.** One-line harness change that
   prevents DO eviction mid-run. The whole reason long browsing can return
   to an evicted DO today. This unblocks shipping the browse tool later.

6. **Collapse the `scheduled()` watchdog to one `wake()` RPC.** Today the
   Worker calls `getStatus() → checkSchedulesDue() → start()` (3 chatty
   RPCs, all racing against state changes). Collapse to a single
   `harness.wake()` whose body does the schedule-check + decision
   internally. The Worker becomes a thin router.

### Phase 2 (next PR) — the big restructure

7. **Collapse subagents into the harness.** Delete `ResearchAgent` and
   `JobApplicationAgent` DOs; move their fetch-rank-persist logic into
   tools the single Harness exposes (`discover_jobs_inlined`,
   `research_inlined`). Update `wrangler.jsonc` migrations to drop the DO
   bindings. Update `getAgents()` to return only the harness.

8. **Add the sendmail tool + approval queue.** New `pending_mails` table
   on the harness; tool returns `needs_approval`; dashboard gets an
   Approve / Reject panel. Out of v1 scope to actually call an SMTP API —
   the tool just writes a row; approval is the gate, transport comes later.

9. **Add browse tool (CDP over `@cloudflare/sandbox` or the Browser API).**
   Wrapped in `keepAliveWhile`, returns extracted markdown under 25k
   tokens. v2-only depending on plan.

10. **Add `onMessage` chat entrypoint.** Separate code path from `runLoop`;
    single `generateText`, streamed reply over the existing WS binding.
    Shares the session log.

### Out of scope for any v1/v2 here

- Multi-agent orchestration — explicitly removed in favor of one harness.
- MCP — deferred until there's a Container; `stdio` MCP isn't possible in
  a Worker DO.
- A `compute()` math tool — models do arithmetic in-prompt fine.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `keepAliveWhile` grow the runtime cost | low | heartbeat is alarm-backed; reference-counted so it's free when no work |
| Subagent collapse loses isolation | medium | fetch-rank-persist logic is unchanged; only the DO boundary goes away |
| Markdown renderer introduces XSS | medium | escape all HTML before applying markdown transforms; never `innerHTML` raw LLM output |
| sendmail approval queue fills up | low | AUTO-EXPIRE pending mails after 7 days (v1.1) |
| `scheduled()` collapse races a wake already in flight | medium | `wake()` early-returns if `status === "running"` |

## Migration notes (will become a CHANGELOG)

- Dashboard JS rewritten against the new CSS palette.
- New files: `public/js/markdown.js`, `public/js/json.js`.
- Harness gains `wake()` (callable), wraps runLoop in `keepAliveWhile`.
- `index.ts` `scheduled()` becomes a one-line forwarder.
- Subagent DOs NOT removed in this pass; that's Phase 2.

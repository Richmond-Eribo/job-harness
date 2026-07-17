// =============================================================================
// Trace page — single-run transcript.
// =============================================================================
// A real route (GET /traces/:runId) so Cmd-click and the back button work.
// The server renders the run header (goal, status, started, token totals);
// the client hydrates #transcript from /api/runs/:runId and groups events
// into step cards with nested sub-agent activity (see dashboard.js
// renderTranscript). While the run is active, the client long-polls
// ?sinceSeq=N to append new steps live.
// =============================================================================
import type { FC } from "hono/jsx"

interface RunMeta {
  runId: string
  goal: string | null
  status: string | null
  startedAt: string | null
  endedAt: string | null
  steps: number
  tokensIn: number
  tokensOut: number
  tokensReasoning: number
  cacheRead: number
  cacheWrite: number
  finishReason: string | null
}

const esc = (s: any) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const fmtTokens = (n: number | null | undefined) =>
  n != null && n > 0 ? Number(n).toLocaleString() : "0"

export const TracePage: FC<{ runId: string; run: RunMeta | null }> = ({
  runId,
  run,
}) => {
  const started = run?.startedAt
    ? new Date(run.startedAt).toLocaleString()
    : "—"
  const ended =
    run?.endedAt && run.endedAt !== run?.startedAt
      ? new Date(run.endedAt).toLocaleString()
      : null

  return (
    <section class="page" id="page-trace" data-run-id={esc(runId)}>
      <div class="card ts-run-card">
        <div class="card-head">
          <div>
            <a href="/traces" class="ts-back">
              ← Runs
            </a>
            <div class="card-title">
              Run <code>{esc(runId.slice(0, 14))}</code>
              {run?.status ? (
                <span
                  class={`status-badge status-${esc(run.status)}`}
                  style="margin-left:10px;vertical-align:middle;"
                >
                  {esc(run.status)}
                </span>
              ) : null}
            </div>
            <div class="card-sub">
              {started}
              {ended ? ` → ${ended}` : ""}
            </div>
          </div>
        </div>

        {/* Run totals — the at-a-glance strip. */}
        <div class="ts-run-totals">
          <div class="ts-total">
            <span class="ts-total-label">steps</span>
            <span class="ts-total-val">{run?.steps ?? 0}</span>
          </div>
          <div class="ts-total">
            <span class="ts-total-label">prompt</span>
            <span class="ts-total-val" style="color:var(--steel)">
              {fmtTokens(run?.tokensIn)}
            </span>
          </div>
          <div class="ts-total">
            <span class="ts-total-label">output</span>
            <span class="ts-total-val" style="color:var(--ok)">
              {fmtTokens(run?.tokensOut)}
            </span>
          </div>
          <div class="ts-total">
            <span class="ts-total-label">reasoning</span>
            <span class="ts-total-val" style="color:var(--warn)">
              {fmtTokens(run?.tokensReasoning)}
            </span>
          </div>
          <div class="ts-total">
            <span class="ts-total-label">cache read</span>
            <span class="ts-total-val">
              {fmtTokens(run?.cacheRead)}
            </span>
          </div>
          <div class="ts-total">
            <span class="ts-total-label">cache write</span>
            <span class="ts-total-val">
              {fmtTokens(run?.cacheWrite)}
            </span>
          </div>
          {run?.finishReason ? (
            <div class="ts-total">
              <span class="ts-total-label">finish</span>
              <span class="ts-total-val">{esc(run.finishReason)}</span>
            </div>
          ) : null}
        </div>

        {run?.goal ? (
          <div class="ts-run-goal">
            <span class="ts-total-label">goal</span>
            <span class="ts-run-goal-text">{esc(run.goal)}</span>
          </div>
        ) : null}
      </div>

      {/* The transcript itself is hydrated client-side. The run header above
          is server-rendered so it's correct on first paint even before the
          events fetch resolves. */}
      <div id="transcript" class="ts-transcript">
        <div class="ts-live-banner" id="ts-live-banner" style="display:none;">
          <span class="ts-live-dot" />{" "}
          <span id="ts-live-text">loading…</span>
        </div>
        <div class="empty">Loading transcript…</div>
      </div>
    </section>
  )
}

export default TracePage

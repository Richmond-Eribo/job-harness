// Settings page — config + goal + schedules + browser, all server-rendered.
// Edits go through the existing JSON API; affected regions re-render via JS
// after the PUT succeeds.
import type { FC } from "hono/jsx"
import { ICONS } from "../Layout"

export const SettingsPage: FC<{
  config: Record<string, string>
  schedules: any[]
}> = ({ config, schedules }) => {
  const esc = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")

  const fields: Array<[string, string]> = [
    ["Goal", config?.goal ?? "—"],
    ["Max steps / run", config?.maxSteps ?? "—"],
    ["Token budget", config?.tokenBudget ?? "—"],
    ["Tokens used", config?.tokensUsed ?? "—"],
    ["LLM provider", config?.llmProvider ?? "—"],
    ["LLM model", config?.llmModel ?? "—"],
    ["Endpoint", config?.customProviderUrl ?? "—"],
  ]

  return (
    <section class="page" id="page-settings">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Configuration</div>
            <div class="card-sub">model + budget (BYOK)</div>
          </div>
        </div>
        <div id="settings-grid" class="settings-grid">
          {fields.map(([k, v]) => (
            <div class="kv">
              <div class="k">{esc(k)}</div>
              <div class="v">{esc(v)}</div>
            </div>
          ))}
        </div>
        <div style="margin-top: 12px;">
          <button class="btn ghost" onclick="showModal('goal-modal')">
            Edit goal + budget + model
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Job sources</div>
            <div class="card-sub">
              real websites the agent is allowed to browse (no hardcoded boards)
            </div>
          </div>
          <button class="btn sm ghost" onclick="showModal('sources-modal')">
            Manage sources
          </button>
        </div>
        <div style="font-size:12px; color:var(--muted-2); line-height:1.5;">
          The agent's <code>discover_jobs</code> tool runs an LLM loop that
          opens pages on the sites you configure here — it never invents URLs,
          and <code>fetch_page</code> refuses any URL whose origin isn't on this
          list. The old Arbeitnow + Remotive hardcoded feeds have been removed.
        </div>
      </div>

      {/* ── Browser capability ─────────────────────────────────────────── */}
      {/* The relay lets the agent drive your real logged-in Chrome for
          login-walled sites. The panel shows connection state + target + how
          to connect the extension. Polled live by loadBrowserStatus(). */}
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Browser</div>
            <div class="card-sub">
              reach login-walled sites (Indeed, LinkedIn) via your real Chrome
            </div>
          </div>
          <span id="browser-target-pill" class="pill pill-off">checking…</span>
        </div>
        <div id="browser-panel" class="browser-panel">
          <div class="empty">Checking browser status…</div>
        </div>

        {/* Test harness — navigate + observe any URL through the connected
            browser. Verifies the whole chain without a full agent run. */}
        <div class="browser-test">
          <div class="card-sub" style="margin: 14px 0 8px;">
            Test the connection — open a URL in the connected browser and read it back:
          </div>
          <div class="browser-test-row">
            <input
              id="browser-test-url"
              type="url"
              placeholder="https://example.com"
              autocomplete="off"
            />
            <button
              class="btn sm primary"
              id="browser-test-btn"
              onclick="probeBrowser()"
            >
              Test
            </button>
          </div>
          <div id="browser-test-result" class="browser-test-result" />
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Goal</div>
            <div class="card-sub">what the agent is working toward</div>
          </div>
          <div style="display:flex; gap: 8px;">
            <button class="btn sm ghost" onclick="showModal('goal-modal')">
              Edit
            </button>
            <button class="btn sm ghost" onclick="synthesizeGoal()">
              Auto-synthesize
            </button>
          </div>
        </div>
        <div class="hero-goal" id="goal-text">
          {esc(config?.goal || "—")}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Schedules</div>
            <div class="card-sub">cron rules the watchdog watches</div>
          </div>
          <button class="btn sm ghost" onclick="showModal('schedule-modal')">
            <span dangerouslySetInnerHTML={{ __html: ICONS.plus }} />
            Add
          </button>
        </div>
        <div id="schedules-list" class="scroll-list">
          {!schedules || schedules.length === 0 ? (
            <div class="empty">No schedules configured.</div>
          ) : (
            schedules.map(s => (
              <div class="row-flex">
                <div class="row-main">
                  <code class="cron">{esc(s.cron)}</code>
                  <span class="focus">({esc(s.focus)})</span>
                </div>
                <div class="row-actions">
                  <span class={"pill " + (s.enabled ? "pill-on" : "pill-off")}>
                    {s.enabled ? "ON" : "OFF"}
                  </span>
                  <button
                    class="small secondary"
                    onclick={`toggleSchedule(${s.id}, ${!s.enabled})`}
                  >
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    class="small danger"
                    onclick={`deleteSchedule(${s.id})`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

export default SettingsPage

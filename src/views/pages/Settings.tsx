// Settings page — config + goal + schedules + research trigger, all
// server-rendered. Edits go through the existing JSON API; affected regions
// re-render via JS after the PUT succeeds.
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

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Research</div>
            <div class="card-sub">manual research trigger</div>
          </div>
          <button class="btn sm ghost" onclick="showModal('research-modal')">
            + Run
          </button>
        </div>
        <div id="research-list" class="scroll-list">
          <div class="empty">Use the modal to run a research sweep.</div>
        </div>
      </div>
    </section>
  )
}

export default SettingsPage

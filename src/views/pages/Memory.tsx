// Memory page — operator notes (user_memory) + agent memory (context table).
// Both rendered server-side. Adding/editing happens client-side via the
// existing JSON API; the affected list is re-rendered by JS after the change.
import type { FC } from "hono/jsx"

export const MemoryPage: FC<{
  userMemory: Array<{ key: string; value: string; updatedAt: string }>
  agentMemory: Array<{ key: string; value: string; updatedAt: string }>
}> = ({ userMemory, agentMemory }) => {
  const esc = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")

  return (
    <section class="page" id="page-memory">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Operator notes (user memory)</div>
            <div class="card-sub">
              human-authored. injected as a high-authority prompt layer above
              the agent's own recall.
            </div>
          </div>
        </div>
        <div class="memory-form">
          <input type="text" id="um-key-input" placeholder="key e.g. target_companies" />
          <input type="text" id="um-value-input" placeholder="value" />
          <button class="btn primary" onclick="saveUserMemory()">Save</button>
        </div>
        <div id="um-list" class="scroll-list">
          {!userMemory || userMemory.length === 0 ? (
            <div class="empty">No notes yet.</div>
          ) : (
            userMemory.map(m => (
              <div class="memory-row" data-key={esc(m.key)}>
                <div class="memory-key"><code>{esc(m.key)}</code></div>
                <div
                  class="memory-value"
                  dangerouslySetInnerHTML={{ __html: esc(m.value) }}
                />
                <button
                  class="small danger"
                  onclick={`forgetUserMemory('${esc(m.key)}')`}
                >
                  remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Agent memory</div>
            <div class="card-sub">
              facts the agent chose to remember via the remember tool
            </div>
          </div>
        </div>
        <div class="memory-form">
          <input type="text" id="memory-key-input" placeholder="key e.g. focus_topic" />
          <input type="text" id="memory-value-input" placeholder="value" />
          <button class="btn primary" onclick="rememberFact()">Remember</button>
        </div>
        <div id="memory-list">
          {!agentMemory || agentMemory.length === 0 ? (
            <div class="empty">No remembered facts yet.</div>
          ) : (
            agentMemory.map(m => (
              <div class="memory-row" data-key={esc(m.key)}>
                <div class="memory-key"><code>{esc(m.key)}</code></div>
                <div
                  class="memory-value"
                  dangerouslySetInnerHTML={{ __html: esc(m.value) }}
                />
                <button
                  class="small danger"
                  onclick={`forgetMemory('${esc(m.key)}')`}
                >
                  forget
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

export default MemoryPage

// =============================================================================
// Layout — the shared HTML shell for every page.
// =============================================================================
// MIGRATION from SPA to pages-as-routes (Vercel Web Interface Guidelines:
// "URL reflects state — tabs in separate routes, not client-side state").
//
// Previously: `GET /` rendered all six pages at once, `dashboard.js` toggled
// `display: block/none` between `.page` sections via `goPage(id)`. No deep
// linking, no back-button, no Cmd-click-into-new-tab.
//
// Now: each page is its own Hono route (`/`, `/jobs`, `/traces`, …). `Layout`
// is the chrome that doesn't change between pages (sidebar, topbar, modals,
// sheet); `{children}` is the page body.
//
// Auth screen stays here as a one-time gate when no token is in localStorage.
// =============================================================================

import { jsxRenderer } from "hono/jsx-renderer"
import type { FC, PropsWithChildren } from "hono/jsx"

// =============================================================================
// Lucide icons — shared by every page via ICONS.
// =============================================================================
const lucide = (children: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${children}</svg>`

export const ICONS = {
  logo: lucide(
    `<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>`,
  ),
  grid: lucide(
    `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  ),
  briefcase: lucide(
    `<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`,
  ),
  activity: lucide(`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`),
  scroll: lucide(
    `<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/>`,
  ),
  brain: lucide(
    `<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>`,
  ),
  settings: lucide(
    `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  ),
  chevronLeft: lucide(`<path d="m15 18-6-6 6-6"/>`),
  menu: lucide(
    `<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>`,
  ),
  search: lucide(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),
  bell: lucide(
    `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  ),
  play: lucide(`<polygon points="6 3 20 12 6 21 6 3"/>`),
  pause: lucide(
    `<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>`,
  ),
  plus: lucide(`<path d="M5 12h14"/><path d="M12 5v14"/>`),
  // Used by the Jobs kanban: hover-delete on a card + "Start discovery run".
  trash: lucide(
    `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
  ),
  sparkles: lucide(
    `<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>`,
  ),
  x: lucide(`<path d="M18 6 6 18"/><path d="M6 6l12 12"/>`),
}

const NAV: Array<{ id: string; label: string; href: string; icon: string }> = [
  { id: "overview", label: "Overview", href: "/", icon: ICONS.grid },
  { id: "jobs", label: "Jobs", href: "/jobs", icon: ICONS.briefcase },
  { id: "traces", label: "Traces", href: "/traces", icon: ICONS.activity },
  { id: "logs", label: "Logs", href: "/logs", icon: ICONS.scroll },
  { id: "memory", label: "Memory", href: "/memory", icon: ICONS.brain },
  { id: "settings", label: "Settings", href: "/settings", icon: ICONS.settings },
]

// Sidebar — real <a href> links. Active page decided by the route, not by JS.
const Sidebar: FC<{ activePage: string }> = ({ activePage }) => (
  <>
    <div class="sb-backdrop" aria-hidden="true" />
    <aside class="sb" id="sidebar">
      <div class="sb-head">
        <span class="sb-logo" dangerouslySetInnerHTML={{ __html: ICONS.logo }} />
        <span class="sb-word">Harness</span>
      </div>
      <nav class="sb-nav" aria-label="Primary">
        {NAV.map(item => (
          <a
            href={item.href}
            class={"sb-item" + (item.id === activePage ? " sb-item-active" : "")}
            data-page-id={item.id}
            aria-current={item.id === activePage ? "page" : undefined}
            // Prefetch on hover/focus so the click is instant. Each page is
            // a small HTML response; prefetching is cheap.
            onmouseover={`prefetch('${item.href}')`}
            onfocus={`prefetch('${item.href}')`}
          >
            <span class="sb-accent" aria-hidden="true" />
            <span class="sb-icon" dangerouslySetInnerHTML={{ __html: item.icon }} />
            <span class="sb-label">{item.label}</span>
          </a>
        ))}
      </nav>
      <div class="sb-foot">
        <button class="sb-collapse" onclick="collapseSidebar()" id="collapse-btn">
          <span dangerouslySetInnerHTML={{ __html: ICONS.chevronLeft }} />
          <span>Collapse</span>
        </button>
      </div>
    </aside>
  </>
)

// Topbar — title mirrors the active page; mobile hamburger + search + bell.
const Topbar: FC<{ activePage: string }> = ({ activePage }) => {
  const title = NAV.find(n => n.id === activePage)?.label ?? "Overview"
  return (
    <header class="topbar">
      <div class="topbar-left">
        <h1 class="page-title" id="page-title">{title}</h1>
        <button
          type="button"
          class="btn ghost nav-toggle"
          onclick="toggleNav()"
          aria-label="Open navigation"
          aria-expanded="false"
          aria-controls="sidebar"
        >
          <span dangerouslySetInnerHTML={{ __html: ICONS.menu }} />
        </button>
        <button
          type="button"
          class="btn primary"
          onclick="startRun()"
          title="Start a run on the current goal"
        >
          <span dangerouslySetInnerHTML={{ __html: ICONS.play }} />
          <span>Run</span>
        </button>
        <button
          type="button"
          class="btn ghost"
          onclick="pauseRun()"
          title="Pause the active run"
          aria-label="Pause the active run"
        >
          <span dangerouslySetInnerHTML={{ __html: ICONS.pause }} />
        </button>
      </div>
      <div class="topbar-right">
        <span id="status-badge" class="status-badge status-idle">IDLE</span>
        <form
          class="search"
          role="search"
          method="get"
          action=""
          // Prevent Enter from submitting to ?q=… (which hard-reloads to top).
          // Search already filters live via oninput on the field below.
          onsubmit="event.preventDefault()"
        >
          <label for="search-input" class="sr-only">Search</label>
          <span class="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.search }} />
          <input
            type="search"
            placeholder="Search…"
            id="search-input"
            name="q"
            autocomplete="off"
            oninput="onSearch(this.value)"
          />
        </form>
        <span class="bell-wrap" id="bell-wrap">
          <button
            type="button"
            class="bell"
            onclick="toggleNotifications(event)"
            title="Notifications"
            aria-label="Notifications"
            aria-expanded="false"
            aria-controls="notif-dropdown"
          >
            <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.bell }} />
            <span class="bell-dot" id="bell-dot" style="display:none;" />
          </button>
          <div class="notif" id="notif-dropdown">
            <div class="notif-head">
              <span class="notif-title">Notifications</span>
              <button
                type="button"
                class="notif-clear"
                onclick="markNotificationsRead()"
              >
                Mark all read
              </button>
            </div>
            <div class="notif-list" id="notif-list">
              <div class="notif-empty">No notifications yet.</div>
            </div>
            <a class="notif-foot" href="/traces">
              View all runs →
            </a>
          </div>
        </span>
        <span class="avatar">A</span>
      </div>
    </header>
  )
}

// AppShell = sidebar + topbar + scrollable main + modals + sheet. Body is
// page-specific (`children`). Rendered on every page so any page can open any
// modal / the sheet.
const AppShell: FC<PropsWithChildren<{ activePage: string }>> = ({
  activePage,
  children,
}) => (
  <div id="dashboard" class="app" style="display: none;">
    <Sidebar activePage={activePage} />
    <main class="main">
      <Topbar activePage={activePage} />
      <div class="main-scroll">{children}</div>
    </main>

    {/* Sheet */}
    <div
      class="sheet-overlay"
      id="sheet-overlay"
      style="display:none;"
      onclick="closeSheet()"
    />
    <aside class="sheet" id="sheet" style="display:none;">
      <div class="sheet-head">
        <h3 id="sheet-title">Detail</h3>
        <button class="icon-btn" onclick="closeSheet()">
          ✕
        </button>
      </div>
      <div class="sheet-body" id="sheet-body" />
    </aside>

    {/* Modals — shared across pages */}
    <div
      id="goal-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('goal-modal')"
    >
      <div class="modal">
        <h3>Edit goal + model</h3>
        <div class="form-group">
          <label class="form-label">Agent Goal</label>
          <textarea
            id="goal-input"
            rows={3}
            placeholder="What should the agent focus on?"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Max Steps Per Run</label>
          <input
            type="number"
            id="max-steps-input"
            value="100"
            min="1"
            max="500"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Token Budget (0 = unlimited)</label>
          <input
            type="number"
            id="budget-input"
            value="0"
            min="0"
            step="10000"
            placeholder="e.g. 200000"
          />
          <div style="font-size:11px; color:var(--muted-2); margin-top:4px;">
            Soft ceiling on cumulative tokens spent per run. 0 disables the cap.
          </div>
        </div>
        <hr class="modal-sep" />
        <h4 style="margin-bottom:8px;">
          Model override (runtime, no redeploy)
        </h4>
        <div class="form-group">
          <label class="form-label">LLM Provider</label>
          <select id="llm-provider-input">
            <option value="">(use llm-config.json default)</option>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="openai-compatible">openai-compatible</option>
            <option value="anthropic-compatible">anthropic-compatible</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">LLM Model Id</label>
          <input
            type="text"
            id="llm-model-input"
            placeholder="e.g. claude-sonnet-4-20250514"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Custom Provider URL (optional)</label>
          <input
            type="url"
            id="custom-provider-url-input"
            placeholder="https://api.example.com/v1"
          />
        </div>
        <div style="font-size:11px; color:var(--muted-2); margin-top:4px;">
          Override one or more. Blank fields fall back to{" "}
          <code>llm-config.json</code>. The API key (<code>LLM_API_KEY</code>)
          is unchanged — switch to a provider with a different key by updating
          the secret too.
        </div>
        <div class="form-row">
          <button onclick="saveGoal()">Save</button>
          <button class="secondary" onclick="hideModal('goal-modal')">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div
      id="schedule-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('schedule-modal')"
    >
      <div class="modal">
        <h3>Manage schedules</h3>
        <div id="schedule-list-modal" />
        <hr class="modal-sep" />
        <h4 style="margin-bottom:12px;">Add Schedule</h4>
        <div class="form-group">
          <label class="form-label">Cron Expression (UTC)</label>
          <input type="text" id="cron-input" placeholder="0 8 * * *" />
          <div style="font-size:11px; color:var(--muted-2); margin-top:4px;">
            Examples: <code>0 8 * * *</code> (daily 8am),{" "}
            <code>0 8,18 * * *</code> (8am+6pm)
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Focus</label>
          <select id="focus-input">
            <option value="all">All (research + jobs)</option>
            <option value="research">Research only</option>
            <option value="jobs">Jobs only</option>
          </select>
        </div>
        <div class="form-row">
          <button onclick="addSchedule()">Add Schedule</button>
          <button class="secondary" onclick="hideModal('schedule-modal')">
            Close
          </button>
        </div>
      </div>
    </div>

    <div
      id="job-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('job-modal')"
    >
      <div class="modal">
        <h3>Add job listing</h3>
        <div class="form-group">
          <label class="form-label">Company</label>
          <input type="text" id="job-company" placeholder="e.g. Cloudflare" />
        </div>
        <div class="form-group">
          <label class="form-label">Job Title</label>
          <input
            type="text"
            id="job-title"
            placeholder="e.g. Senior Software Engineer"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea
            id="job-description"
            rows={4}
            placeholder="Paste the job description here…"
          />
        </div>
        <div class="form-group">
          <label class="form-label">URL</label>
          <input type="url" id="job-url" placeholder="https://…" />
        </div>
        <div class="form-row">
          <button onclick="addJob()">Add Job</button>
          <button class="secondary" onclick="hideModal('job-modal')">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div
      id="profile-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('profile-modal')"
    >
      <div class="modal">
        <h3>Your profile</h3>
        <div class="form-group">
          <label class="form-label">CV / Resume</label>
          <textarea
            id="profile-cv"
            rows={8}
            placeholder="Paste your CV here…"
          />
          <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
            <input
              type="file"
              id="profile-cv-file"
              accept=".txt,.md,.markdown,.pdf,.doc,.docx,.rtf,.html"
              style="font-size: 11px; flex: 1;"
            />
            <button
              type="button"
              class="btn sm ghost"
              onclick="uploadProfileCvFile()"
            >
              Load file
            </button>
          </div>
          <div style="font-size: 10px; color: var(--text-3); margin-top: 4px;">
            Loads .txt / .md inline. PDF / DOCX are uploaded raw to
            /api/profile/cv.
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Target Roles</label>
          <input
            type="text"
            id="profile-roles"
            placeholder="e.g. Senior Software Engineer"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Target Locations</label>
          <input
            type="text"
            id="profile-locations"
            placeholder="e.g. London, Remote"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Key Skills</label>
          <input
            type="text"
            id="profile-skills"
            placeholder="TypeScript, React, Cloudflare Workers"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Preferences / Notes</label>
          <textarea
            id="profile-preferences"
            rows={3}
            placeholder="Work style, etc."
          />
        </div>
        <div class="form-row">
          <button onclick="saveProfile()">Save Profile</button>
          <button class="secondary" onclick="hideModal('profile-modal')">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div
      id="research-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('research-modal')"
    >
      <div class="modal">
        <h3>Run research</h3>
        <div class="form-group">
          <label class="form-label">Topic</label>
          <input
            type="text"
            id="research-topic"
            placeholder="e.g. Agents SDK best practices"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Depth</label>
          <select id="research-depth">
            <option value="quick">Quick (3 steps)</option>
            <option value="standard" selected>
              Standard (5 steps)
            </option>
            <option value="deep">Deep (10 steps)</option>
          </select>
        </div>
        <div class="form-row">
          <button onclick="runResearch()">Start Research</button>
          <button class="secondary" onclick="hideModal('research-modal')">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div
      id="cover-letter-modal"
      class="modal-overlay"
      style="display: none;"
      onclick="if(event.target===this)hideModal('cover-letter-modal')"
    >
      <div class="modal">
        <h3>Cover letter</h3>
        <div
          id="cover-letter-content"
          style="white-space: pre-wrap; font-size:14px; line-height:1.7;"
        />
        <button
          class="secondary"
          onclick="hideModal('cover-letter-modal')"
          style="margin-top:16px;"
        >
          Close
        </button>
      </div>
    </div>
  </div>
)

// HTML shell — <html>/<head>/<body>. Children = the AppShell.
const HtmlShell: FC<PropsWithChildren> = ({ children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Agent Harness — Dashboard</title>
      <meta name="description" content="Autonomous AI agent orchestrator dashboard" />
      <meta name="color-scheme" content="dark" />
      <meta name="theme-color" content="#0a0d13" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,100..900;1,100..900&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      {/* CSS — single stylesheet (v3 already collapsed v1/v2 layers in). */}
      <link rel="stylesheet" href="/css/dashboard.css" />
    </head>
    <body>
      {/* Auth screen — visible until JS verifies the stored token. */}
      <div id="auth-screen" class="auth-screen">
        <div class="auth-card">
          <span class="sb-logo" dangerouslySetInnerHTML={{ __html: ICONS.logo }} />
          <h2>Agent Harness</h2>
          <p>Enter your dashboard token to continue.</p>
          <div class="form-group">
            <input type="password" id="token-input" placeholder="Dashboard token" autocomplete="off" />
          </div>
          <button onclick="authenticate()">Connect</button>
        </div>
      </div>
      {children}
      <script src="/js/markdown.js" defer></script>
      <script src="/js/json.js" defer></script>
      {/* spa-nav must load before dashboard.js so window.navigate() exists
          when dashboard.js boots and references it (notifications, trace rows). */}
      <script src="/js/spa-nav.js" defer></script>
      <script src="/js/dashboard.js" defer></script>
    </body>
  </html>
)

// =============================================================================
// PageLayout — wraps a page body in the AppShell. Each route renders
// `<PageLayout activePage="…"><PageBody/></PageLayout>` via `c.render()`.
// =============================================================================
export const PageLayout: FC<PropsWithChildren<{ activePage: string }>> = ({
  activePage,
  children,
}) => <AppShell activePage={activePage}>{children}</AppShell>

// =============================================================================
// Renderer middleware — wraps c.render(<PageLayout/>) in the HTML shell.
// Registered as `app.use("/{*}", renderer)` so every page route gets the
// shell. API routes return c.json() and bypass this.
// =============================================================================
export const renderer = jsxRenderer(
  ({ children }) => <HtmlShell>{children}</HtmlShell>,
  {
    docType: "<!DOCTYPE html>\n",
  },
)

import { useEffect } from "react"
import { Link, Outlet, useRouterState, useNavigate } from "@tanstack/react-router"
import { authClient } from "../lib/auth"

// The nav entries. `/` (marketing) is public; the app shell routes start at
// /dashboard.
const NAV = [
  { id: "/dashboard", label: "Overview", icon: "📊" },
  { id: "/jobs", label: "Jobs", icon: "💼" },
  { id: "/traces", label: "Traces", icon: "🔍" },
  { id: "/logs", label: "Logs", icon: "📋" },
  { id: "/memory", label: "Memory", icon: "🧠" },
  { id: "/settings", label: "Settings", icon: "⚙️" },
] as const

// Routes that render WITHOUT the sidebar shell (public/auth surfaces).
const SHELL_LESS = new Set(["/", "/login", "/signup", "/onboarding"])

export function AppLayout() {
  const session = authClient.useSession()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: s => s.location.pathname })

  // --- Auth + onboarding guards ---
  // After the session resolves, redirect based on auth state:
  //   - logged-in on `/`           → `/dashboard` (or `/onboarding` if not onboarded)
  //   - logged-in on `/login`|`/signup` → `/dashboard` (or `/onboarding`)
  //   - logged-out on an app route (not `/`, `/login`, `/signup`) → `/login`
  //   - logged-in + not onboarded on an app route → `/onboarding`
  useEffect(() => {
    if (session.isPending) return // still loading — wait
    const user = session.data?.user as any
    const onboardingDone = user?.onboardingComplete !== false
    const onPublicRoot = pathname === "/"
    const onAuth = pathname === "/login" || pathname === "/signup"
    const onOnboarding = pathname === "/onboarding"

    if (!session.data) {
      // Logged out: only redirect away from protected app routes. The marketing
      // page (`/`) and the auth pages render for anonymous visitors.
      if (!onPublicRoot && !onAuth) navigate({ to: "/login" })
      return
    }

    // Logged in. Send marketing/auth visitors into the app.
    if (onPublicRoot || onAuth) {
      navigate({ to: onboardingDone ? "/dashboard" : "/onboarding" })
      return
    }

    // On an app route: enforce the onboarding gate.
    if (!onOnboarding && !onboardingDone) {
      navigate({ to: "/onboarding" })
    }
  }, [session.isPending, session.data, pathname, navigate])

  // While the session is loading, show a minimal loader on app routes only
  // (public surfaces render immediately for a snappy first paint).
  if (session.isPending && !SHELL_LESS.has(pathname)) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Loading…
      </div>
    )
  }

  // Public + auth + onboarding pages render WITHOUT the sidebar shell.
  if (SHELL_LESS.has(pathname)) {
    return <Outlet />
  }

  // Not authenticated on a protected route → just the outlet (the guard above
  // redirects to /login).
  if (!session.data) {
    return <Outlet />
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-card border-r border-border flex flex-col">
        <div className="px-5 py-5 text-lg font-bold text-foreground border-b border-border">
          Job Agent
        </div>
        <nav className="flex-1 py-3">
          {NAV.map(item => {
            const active = pathname === item.id
            return (
              <Link
                key={item.id}
                to={item.id}
                className={`flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  active
                    ? "bg-secondary text-foreground border-l-2 border-accent"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground border-l-2 border-transparent"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <div className="text-xs text-muted-foreground mb-1 truncate">
            {session.data?.user?.email}
          </div>
          <button
            onClick={() => authClient.signOut().then(() => navigate({ to: "/login" }))}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-background">
        <Outlet />
      </main>
    </div>
  )
}

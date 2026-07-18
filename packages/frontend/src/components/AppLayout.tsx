import { useEffect } from "react"
import { Link, Outlet, useRouterState, useNavigate } from "@tanstack/react-router"
import { authClient } from "../lib/auth"

// The nav entries. Matching the legacy dashboard's structure.
const NAV = [
  { id: "/", label: "Overview", icon: "📊" },
  { id: "/jobs", label: "Jobs", icon: "💼" },
  { id: "/traces", label: "Traces", icon: "🔍" },
  { id: "/logs", label: "Logs", icon: "📋" },
  { id: "/memory", label: "Memory", icon: "🧠" },
  { id: "/settings", label: "Settings", icon: "⚙️" },
] as const

export function AppLayout() {
  const session = authClient.useSession()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: s => s.location.pathname })

  // --- Auth + onboarding guards ---
  // After the session resolves, redirect based on auth state:
  //   - not logged in AND not on /login → /login
  //   - logged in, not onboarded, not on /onboarding → /onboarding
  useEffect(() => {
    if (session.isPending) return // still loading — wait
    const onLogin = pathname === "/login"
    const onOnboarding = pathname === "/onboarding"

    if (!session.data) {
      if (!onLogin) navigate({ to: "/login" })
      return
    }

    // Logged in. If onboarding incomplete, force onboarding (unless already
    // there, or on /login which we redirect away from).
    if (!onLogin && !onOnboarding) {
      // The onboardingComplete flag comes from the session user object.
      // We check it via the profile/onboarding status — the session carries it
      // through Better Auth's additional field.
      const user = session.data?.user as any
      if (user && user.onboardingComplete === false) {
        navigate({ to: "/onboarding" })
      }
    }

    // If logged in + onboarded but sitting on /login or /onboarding, go home.
    if ((onLogin || onOnboarding) && session.data) {
      const user = session.data?.user as any
      if (onLogin || (onOnboarding && user?.onboardingComplete !== false)) {
        navigate({ to: "/" })
      }
    }
  }, [session.isPending, session.data, pathname, navigate])

  // While the session is loading, show a minimal loader.
  if (session.isPending) {
    return (
      <div className="flex items-center justify-center h-screen text-ink-500">
        Loading…
      </div>
    )
  }

  // Login + onboarding pages render WITHOUT the sidebar shell.
  if (pathname === "/login" || pathname === "/onboarding") {
    return <Outlet />
  }

  // Not authenticated → just the outlet (the guard above redirects to /login).
  if (!session.data) {
    return <Outlet />
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col">
        <div className="px-5 py-5 text-lg font-bold text-ink-100 border-b border-ink-800">
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
                    ? "bg-ink-800 text-white border-l-2 border-accent"
                    : "text-ink-300 hover:bg-ink-800/50 hover:text-ink-100 border-l-2 border-transparent"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-ink-800">
          <div className="text-xs text-ink-500 mb-1 truncate">
            {session.data?.user?.email}
          </div>
          <button
            onClick={() => authClient.signOut().then(() => navigate({ to: "/login" }))}
            className="text-xs text-ink-500 hover:text-red-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

// =============================================================================
// Layout — the authed app shell (sidebar + topbar + content outlet).
// =============================================================================
// EXTRACTED from routes/__root.tsx (Phase 4 cleanup) so the shell is testable
// + reusable independently of the root route. The root route keeps only its
// minimum responsibilities: providers (QueryClient, Toaster), ErrorBoundary,
// Suspense, + root document.
//
// Components exported here:
//   • Shell               — the full sidebar+topbar chrome around <Outlet/>
//   • ShellSkeleton       — used as the Suspense fallback + auth-pending
//                           placeholder, so both pre-mount states share the
//                           same layout.
//   • ExtensionStatusPill — topbar pill (Phase 1) showing whether the agent
//                           has a live browser target.
//   • NotificationsBell   — topbar dropdown (Phase 4) for the previously
//                           unused useNotifications hook.
//
// SHELL_LESS routing is enforced in __root.tsx (anonymous + onboarding pages
// bypass the shell entirely).
// =============================================================================
import { useCallback, useEffect, useState } from "react"
import {
  Outlet,
  useRouter,
  useRouterState,
  useNavigate,
  Link,
} from "@tanstack/react-router"
import {
  LayoutDashboard,
  Briefcase,
  Search,
  ScrollText,
  Brain,
  Settings,
  LogOut,
  Sparkles,
  Command,
  Bell,
  Chrome,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react"
import { authClient, signOutClient } from "../lib/auth"
import { Button, Skeleton } from "@agent-harness/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@agent-harness/ui"
import { useBrowserStatus, useNotifications } from "../hooks/queries"
import { queryClient } from "./query-client"

const NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "/jobs", label: "Jobs", icon: Briefcase },
  { id: "/traces", label: "Traces", icon: Search },
  { id: "/logs", label: "Logs", icon: ScrollText },
  { id: "/memory", label: "Memory", icon: Brain },
  { id: "/settings", label: "Settings", icon: Settings },
]

/**
 * Mounted inside RootComponent's <Suspense fallback={...}> so the auth-pending
 * state and any lazy-route loading state both render the same chrome shape —
 * no harsh flash between "logged in, loading" and "loaded".
 */
export function ShellSkeleton() {
  return (
    <div className="flex h-screen bg-background">
      <div className="w-64 shrink-0 bg-card border-r border-border flex flex-col gap-2 p-4">
        <Skeleton className="h-8 w-36 mb-4" />
        <div className="flex flex-col gap-2">
          {NAV.map(n => (
            <Skeleton key={n.id} className="h-9 w-full rounded-md" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-8 flex flex-col gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  )
}

export function Shell() {
  const session = authClient.useSession()
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: s => s.location.pathname })

  // ── MOBILE DRAWER ──────────────────────────────────────────────────────
  // The legacy dashboard had an off-canvas drawer (toggleNav/.nav-open). The
  // React shell regressed that — `w-64 shrink-0` only worked on desktop, so
  // tablets/phones showed a sidebar eating most of the viewport with no way
  // to dismiss it. This drawer state + overlay restores mobile/tablet
  // usability: sidebar is fixed-position off-screen by default below lg,
  // slides in when `navOpen` is true, and closes on link click or route
  // change.
  const [navOpen, setNavOpen] = useState(false)
  // Auto-close on path change so navigating doesn't strand the drawer open.
  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  // Stable so <Button onClick={handleSignOut}> doesn't get a fresh closure
  // every render. Closes only over stable refs.
  const handleSignOut = useCallback(async () => {
    const result = await signOutClient()
    // Always clear React Query cache so any in-flight dashboard request
    // can't repopulate auth-gated data post-sign-out.
    queryClient.clear()
    if (!result.ok) {
      console.warn("[sign-out] failed:", result.error)
    }
    await router.invalidate()
    await navigate({ to: "/login", replace: true })
  }, [router, navigate])

  if (session.isPending) {
    return <ShellSkeleton />
  }

  const userEmail = session.data?.user?.email ?? ""
  const monogram = userEmail.charAt(0).toUpperCase() || "?"
  const currentNavItem = NAV.find(n => n.id === pathname)

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile drawer backdrop (lg:hidden). Clicking outside the drawer
          closes it. Renders only when the drawer is open so the rest of the
          viewport stays interactive otherwise. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Left Navigation Sidebar —
          • lg and up: static, always visible, w-64.
          • below lg: fixed off-canvas drawer (translate-x-(-100%) when
            closed, translate-x-0 when open). Z-40 sits above the backdrop
            but below modals/dialogs that might be mounted at z-50.
          The transition on transform gives the slide animation. */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 shrink-0 bg-card border-r border-border flex flex-col justify-between transition-transform duration-200 lg:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div>
          {/* Brand Logo */}
          <div className="px-5 py-5 flex items-center justify-between border-b border-border">
            <Link to="/dashboard" className="flex items-center gap-2.5">
              <span
                className="size-7 rounded-lg bg-primary grid place-items-center text-primary-foreground text-xs font-bold shadow-sm"
                aria-hidden
              >
                J
              </span>
              <span className="text-base font-semibold tracking-tight text-foreground">
                Job Agent
              </span>
            </Link>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border">
              <Sparkles className="size-3 text-primary" />
              v1.0
            </span>
          </div>

          {/* Quick Command Trigger Bar (decorative — see Phase 1.5 in
              plan-extensionUxAndJobApplicationFlow.prompt.md re: cmdk build).
              Kept as a non-interactive affordance so the layout doesn't
              shift when/if a real palette ships. */}
          <div className="px-3 pt-4 pb-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground bg-background border border-border px-3 py-1.5 rounded-lg">
              <span className="flex items-center gap-2">
                <Command className="size-3.5" />
                <span>Command Menu</span>
              </span>
              <kbd className="font-mono text-[10px] bg-secondary px-1.5 py-0.5 rounded border border-border">
                ⌘K
              </kbd>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="px-3 py-2 flex flex-col gap-1">
            {NAV.map(item => {
              const active =
                pathname === item.id ||
                (item.id === "/traces" && pathname.startsWith("/traces"))
              const Icon = item.icon
              return (
                <Link
                  key={item.id}
                  to={item.id}
                  className={`group relative flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
                    active
                      ? // nav-state-active: muted-blue pill + primary-blue
                        // icon/text per §10.2.
                        "bg-accent text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {active && (
                      <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                    )}
                    <Icon className="size-4 shrink-0" />
                    <span className="transition-transform duration-150 group-hover:translate-x-0.5">
                      {item.label}
                    </span>
                  </div>
                </Link>
              )
            })}
          </nav>
        </div>

        {/* User Profile Footer — sign-out stays visually separated
            (destructive-nav-separation per §10.2): its own bordered row. */}
        <div className="p-3 border-t border-border bg-card">
          <div className="flex items-center justify-between p-2 rounded-lg bg-muted/50 border border-border mb-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="size-7 rounded-full bg-primary/20 text-primary grid place-items-center text-xs font-semibold shrink-0">
                {monogram}
              </span>
              <span className="text-xs text-foreground font-medium truncate">
                {userEmail}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={handleSignOut}
          >
            <LogOut className="size-3.5 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Right Content Area with Header Bar */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header Bar */}
        <header className="h-14 border-b border-border bg-card px-4 sm:px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {/* Mobile hamburger — toggles the off-canvas drawer (lg:hidden). */}
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label={navOpen ? "Close navigation" : "Open navigation"}
              onClick={() => setNavOpen(o => !o)}
            >
              {navOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </Button>
            <span className="text-sm font-semibold text-foreground">
              {currentNavItem?.label ?? "Dashboard"}
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Extension-status pill — the only always-visible signal that
                the agent has a live browser target. Polls every 15s; red
                dot when target==="none" so an unpaired/lost browser is never
                silently invisible. Links to Settings → Browser tab. */}
            <ExtensionStatusPill />
            <NotificationsBell />
            <span className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground bg-card border border-border px-2.5 py-1 rounded-md">
              <span className="size-2 rounded-full bg-success" />
              <span>Runtime Online</span>
            </span>
          </div>
        </header>

        {/* Page Main Outlet */}
        <main className="flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

// Extension-status pill for the topbar. Renders nothing while the status
// query is still loading (no flash of "disconnected"). Clicking it
// deep-links straight to Settings → Browser tab.
export function ExtensionStatusPill() {
  const { data, isError } = useBrowserStatus()
  // On error (e.g. 401 mid-session), don't render — the router guards will
  // bounce to /login. Showing a red "not connected" pill during a session
  // blip would be misleading.
  if (isError) return null
  if (!data) return null

  const target = data.target
  // Three states, mapped to color + copy:
  //   live     → green  "Browser connected"
  //   managed  → blue   "Managed browser"  (paid-plan headless, rare)
  //   none     → red    "No browser"       (click to pair)
  const isOk = target !== "none"
  const label =
    target === "live"
      ? "Browser connected"
      : target === "managed"
        ? "Managed browser"
        : "No browser"
  // color-not-only: the dot always carries a text label (§10.2).
  const dotClass = isOk
    ? target === "managed"
      ? "bg-primary"
      : "bg-success"
    : "bg-destructive"

  return (
    <Link
      to="/settings"
      search={{ tab: "browser" }}
      title={
        isOk
          ? "Browser relay connected — click to manage"
          : "No browser connected — click to install & pair the extension"
      }
      className="flex items-center gap-2 text-xs bg-card border border-border px-2.5 py-1 rounded-md hover:border-primary/40 hover:bg-accent/40 transition-colors"
    >
      <Chrome className={`size-3.5 ${isOk ? "text-muted-foreground" : "text-destructive"}`} />
      <span className={`size-2 rounded-full ${dotClass}`} />
      <span
        className={`hidden md:inline ${
          isOk ? "text-muted-foreground" : "text-destructive font-medium"
        }`}
      >
        {label}
      </span>
    </Link>
  )
}

// Notifications bell — surfaces the useNotifications hook (polled every 15s)
// in a Radix DropdownMenu. Focus management, Escape, and outside-click are
// handled by the primitive — no hand-rolled listeners.
export function NotificationsBell() {
  const { data } = useNotifications()

  const items = Array.isArray(data) ? data.slice(0, 12) : []
  const count = items.length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${count > 0 ? ` (${count} new)` : ""}`}
        >
          <Bell className="size-4" />
          {count > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold grid place-items-center"
              aria-hidden
            >
              {count > 9 ? "9+" : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <DropdownMenuLabel className="p-0 text-xs font-semibold text-foreground uppercase tracking-wider">
            Notifications
          </DropdownMenuLabel>
          <span className="text-[10px] text-muted-foreground font-mono">
            {count} recent
          </span>
        </div>
        <div className="max-h-96 overflow-auto">
          {count === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              Nothing needs you right now.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map(n => (
                <li
                  key={String(n.id ?? `${n.message}-${n.createdAt ?? ""}`)}
                  className="px-4 py-3"
                >
                  <p className="text-xs text-foreground leading-relaxed">
                    {n.message}
                  </p>
                  {n.createdAt && (
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

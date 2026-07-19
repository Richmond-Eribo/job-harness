import { useState } from "react"
import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  useRouterState,
  useNavigate,
  Link,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import "../index.css"
import {
  QueryClient,
  QueryCache,
  MutationCache,
  QueryClientProvider,
} from "@tanstack/react-query"
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
  type LucideIcon,
} from "lucide-react"
import { authClient, signOutClient } from "../lib/auth"
import { ApiError } from "../lib/api"
import { Button, Skeleton, Toaster } from "@agent-harness/ui"
import { ErrorBoundary } from "../components/ErrorBoundary"

const NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "/jobs", label: "Jobs", icon: Briefcase },
  { id: "/traces", label: "Traces", icon: Search },
  { id: "/logs", label: "Logs", icon: ScrollText },
  { id: "/memory", label: "Memory", icon: Brain },
  { id: "/settings/profile", label: "Profile", icon: Settings },
]

const SHELL_LESS = new Set([
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/onboarding",
])

function Shell() {
  const session = authClient.useSession()
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: s => s.location.pathname })

  if (SHELL_LESS.has(pathname)) {
    return <Outlet />
  }

  if (session.isPending) {
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

  const userEmail = session.data?.user?.email ?? ""
  const monogram = userEmail.charAt(0).toUpperCase() || "?"
  const currentNavItem = NAV.find(n => n.id === pathname)

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Left Navigation Sidebar */}
      <aside className="w-64 shrink-0 bg-card border-r border-border flex flex-col justify-between">
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
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-muted-foreground bg-secondary rounded border border-border">
              <Sparkles className="size-3 text-primary" />
              v1.0
            </span>
          </div>

          {/* Quick Command Trigger Bar */}
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
                  className={`group relative flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
                    active
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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

        {/* User Profile Footer */}
        <div className="p-3 border-t border-border bg-card">
          <div className="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border mb-2">
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
            // LOGOUT FLOW (post-rewrite 2026-07-19):
            //   1. Call the worker's /api/auth/sign-out via signOutClient()
            //      which calls authClient.signOut() under the hood.
            //   2. On success: router.invalidate() forces every beforeLoad
            //      (including the fetchSession server fn) to re-run, so the
            //      authed context is gone before we navigate.
            //   3. navigate to /login with replace:true so the back button
            //      doesn't return into the authed app.
            //   4. On failure: still navigate to /login — better to strand
            //      the user on the login screen than leave a stale session
            //      visible. The QueryClient cache is cleared so the dashboard
            //      pollers can't write into it during the brief window.
            onClick={async () => {
              const result = await signOutClient()
              // Always clear React Query cache so any in-flight dashboard
              // request can't repopulate auth-gated data post-sign-out.
              queryClient.clear()
              if (!result.ok) {
                console.warn("[sign-out] failed:", result.error)
              }
              await router.invalidate()
              await navigate({ to: "/login", replace: true })
            }}
          >
            <LogOut className="size-3.5 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Right Content Area with Header Bar */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header Bar */}
        <header className="h-14 border-b border-border bg-card/50 px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-foreground">
              {currentNavItem?.label ?? "Dashboard"}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground font-mono bg-background border border-border px-2.5 py-1 rounded-md">
              <span className="size-2 rounded-full bg-success animate-pulse" />
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

function onQueryError(err: unknown): void {
  if (typeof window === "undefined") return
  if (!(err instanceof ApiError)) return
  if (err.status === 401) {
    window.location.assign("/login")
  } else if (err.status === 428) {
    window.location.assign("/onboarding")
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
  queryCache: new QueryCache({ onError: onQueryError }),
  mutationCache: new MutationCache({ onError: onQueryError }),
})

export const Route = createRootRouteWithContext()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Job Agent" },
      {
        name: "description",
        content:
          "An AI agent that finds jobs, scores them, and writes cover letters.",
      },
      { name: "color-scheme", content: "dark light" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: () => <NotFound />,
  errorComponent: ({ error }) => <FatalError error={error} />,
})

function RootComponent() {
  const [client] = useState(() => queryClient)
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <Shell />
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground">
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="text-8xl font-mono font-bold leading-none text-muted-foreground/20 select-none">
          404
        </div>
        <h1 className="text-xl font-semibold -mt-2 mb-2">Page not found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          The requested route doesn't exist or has been moved.
        </p>
        <Link
          to="/"
          className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors"
        >
          Back to Overview
        </Link>
      </div>
    </div>
  )
}

function FatalError({ error }: { error: Error }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="text-6xl font-mono font-bold leading-none text-destructive/30 select-none mb-4">
          ERR
        </div>
        <h1 className="text-xl font-semibold mb-2">Application Error</h1>
        <p className="text-sm text-muted-foreground mb-4">
          An error occurred in the execution context.
        </p>
        <pre className="text-xs text-left bg-secondary/50 border border-border rounded-lg p-3 mb-6 overflow-auto max-h-40 font-mono">
          {error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors"
        >
          Reload Dashboard
        </button>
      </div>
    </div>
  )
}

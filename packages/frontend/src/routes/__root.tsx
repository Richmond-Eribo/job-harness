import { useState } from "react"
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
  useNavigate,
  Link,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
// Global stylesheet. Importing it here pulls it into Vite's module graph so
// @tailwindcss/vite compiles it and TanStack Start hoists the resulting
// <link rel="stylesheet"> into the SSR <head>. Without this import the whole
// app renders unstyled.
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
  type LucideIcon,
} from "lucide-react"
import { authClient } from "../lib/auth"
import { ApiError } from "../lib/api"
import { Button, Skeleton, Toaster } from "@agent-harness/ui"
import { ErrorBoundary } from "../components/ErrorBoundary"

// Root route (file-based). Owns:
//   - The HTML document shell (shellComponent = RootDocument) — Start renders
//     this server-side so view-source shows real HTML (SEO for the marketing
//     surface). HeadContent/Scripts are injected by the framework.
//   - The providers (QueryClient, ErrorBoundary, Toaster).
//   - The app shell (sidebar) + auth/onboarding guards (the Shell component).

const NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "/jobs", label: "Jobs", icon: Briefcase },
  { id: "/traces", label: "Traces", icon: Search },
  { id: "/logs", label: "Logs", icon: ScrollText },
  { id: "/memory", label: "Memory", icon: Brain },
  { id: "/settings", label: "Settings", icon: Settings },
]

// Routes that render WITHOUT the sidebar shell (public/auth surfaces).
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
  const pathname = useRouterState({ select: s => s.location.pathname })

  // Public + auth + onboarding pages render WITHOUT the sidebar shell.
  // (Access control itself is handled by each route's beforeLoad guard —
  // see src/lib/guards.ts. This is purely presentational.)
  if (SHELL_LESS.has(pathname)) {
    return <Outlet />
  }

  // Brief skeleton while the session resolves on an app route. The beforeLoad
  // guard already ensured a session exists; this just smooths the first paint.
  if (session.isPending) {
    return (
      <div className="flex h-screen bg-background">
        <div className="w-60 shrink-0 bg-card/60 border-r border-border flex flex-col gap-2 p-3">
          <Skeleton className="h-8 w-32 m-2" />
          <div className="flex flex-col gap-1 mt-4">
            {NAV.map(n => (
              <Skeleton key={n.id} className="h-9 w-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-6 flex flex-col gap-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen">
      <aside className="w-60 shrink-0 bg-card/60 backdrop-blur-sm border-r border-border flex flex-col">
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-border">
          <span
            className="size-7 rounded-lg bg-primary grid place-items-center text-primary-foreground shadow-sm"
            aria-hidden
          >
            <Briefcase className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-foreground">
            Job Agent
          </span>
        </div>
        <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
          {NAV.map(item => {
            const active = pathname === item.id
            const Icon = item.icon
            return (
              <Link
                key={item.id}
                to={item.id}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-3 border-t border-border flex flex-col gap-2">
          <div className="px-3 text-xs text-muted-foreground truncate">
            {session.data?.user?.email}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground hover:text-destructive"
            onClick={() =>
              authClient.signOut().then(() => navigate({ to: "/login" }))
            }
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-background">
        <Outlet />
      </main>
    </div>
  )
}

// Global listener for auth-state errors. Any ApiError from a react-query query
// or mutation is intercepted here: 401 (session expired) → hard-navigate to
// /login; 428 (onboarding incomplete) → /onboarding. We use window.location
// (not router.navigate) on 401 because the session is gone and a router-level
// transition could trigger more 401s during the cutover. SSR-guarded — on the
// server these surface via the route errorComponent instead.
function onQueryError(err: unknown): void {
  if (typeof window === "undefined") return
  if (!(err instanceof ApiError)) return
  if (err.status === 401) {
    window.location.assign("/login")
  } else if (err.status === 428) {
    window.location.assign("/onboarding")
  }
}

// Single QueryClient. On the client this is a singleton (useState guards the
// reference so it survives re-renders); on the server Start manages per-request
// instances. staleTime 0 = queries refetch on focus — good for a live dashboard.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
  queryCache: new QueryCache({ onError: onQueryError }),
  mutationCache: new MutationCache({ onError: onQueryError }),
})

export const Route = createRootRouteWithContext()({
  // head: document <head> tags. SSR renders these so crawlers see real metadata.
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Job Agent" },
      {
        name: "description",
        content:
          "An AI agent that finds jobs, scores them, and writes the cover letters.",
      },
      { name: "color-scheme", content: "dark light" },
    ],
    links: [
      // Landing typography: Inter (display + body neo-grotesque) and JetBrains
      // Mono (eyebrows, trace card, numerals). display=swap so the system
      // fallback renders immediately and swaps in once loaded (no FOIT).
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
  // shellComponent: the HTML document wrapper. Start renders this on the server
  // and injects HeadContent (the head tags above) + Scripts (the client bundle).
  // The matched route's component renders inside {children}.
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
      <div className="text-center">
        <h1 className="text-xl font-bold mb-2">Not found</h1>
        <Link
          to="/"
          className="text-sm text-primary hover:underline"
        >
          Go home
        </Link>
      </div>
    </div>
  )
}

function FatalError({ error }: { error: Error }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
        <pre className="text-xs text-left bg-secondary/50 border border-border rounded-md p-3 mb-6 overflow-auto max-h-40">
          {error.message}
        </pre>
      </div>
    </div>
  )
}

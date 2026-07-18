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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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
import { Skeleton, Toaster } from "@agent-harness/ui"
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

  // While the session is loading, show a minimal skeleton on app routes only
  // (public surfaces render immediately for a snappy first paint).
  if (session.isPending && !SHELL_LESS.has(pathname)) {
    return (
      <div className="flex h-screen bg-background">
        <div className="w-56 shrink-0 bg-card border-r border-border flex flex-col gap-2 p-4">
          <Skeleton className="h-6 w-24" />
          <div className="flex flex-col gap-2 mt-4">
            {NAV.map(n => (
              <Skeleton key={n.id} className="h-8 w-full" />
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

  // Public + auth + onboarding pages render WITHOUT the sidebar shell.
  if (SHELL_LESS.has(pathname)) {
    return <Outlet />
  }

  // Not authenticated on a protected route → bare outlet (the guard redirects).
  if (!session.data) {
    return <Outlet />
  }

  return (
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 bg-card border-r border-border flex flex-col">
        <div className="px-5 py-5 text-lg font-bold text-foreground border-b border-border">
          Job Agent
        </div>
        <nav className="flex-1 py-3">
          {NAV.map(item => {
            const active = pathname === item.id
            const Icon = item.icon
            return (
              <Link
                key={item.id}
                to={item.id}
                className={`flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  active
                    ? "bg-secondary text-foreground border-l-2 border-primary"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground border-l-2 border-transparent"
                }`}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <div className="text-xs text-muted-foreground mb-2 truncate">
            {session.data?.user?.email}
          </div>
          <button
            onClick={() =>
              authClient.signOut().then(() => navigate({ to: "/login" }))
            }
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-background">
        <Outlet />
      </main>
    </div>
  )
}

// Single QueryClient. On the client this is a singleton (useState guards the
// reference so it survives re-renders); on the server Start manages per-request
// instances. staleTime 0 = queries refetch on focus — good for a live dashboard.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
})

export const Route = createRootRouteWithContext()({
  // head: document <head> tags. SSR renders these so crawlers see real metadata.
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Job Agent" },
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

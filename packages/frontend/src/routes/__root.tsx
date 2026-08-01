import { Suspense, useState } from "react"
import {
  createRootRouteWithContext,
  Link,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import "../index.css"
import { QueryClientProvider } from "@tanstack/react-query"
import { ErrorBoundary } from "../components/ErrorBoundary"
import { Shell, ShellSkeleton } from "../components/Layout"
import { queryClient } from "../components/query-client"
import { Toaster } from "@agent-harness/ui"

// Root route — providers + document chrome only.
//
// All app-shell chrome (sidebar, topbar, mobile drawer, ExtensionStatusPill,
// NotificationsBell) was extracted to src/components/Layout.tsx in the
// Phase 4 consolidation. This file keeps only:
//   • Provider tree (ErrorBoundary → QueryClientProvider → Suspense → Shell)
//   • Toaster (sonner) mounted at the root so any page can fire toasts
//   • RootDocument (the <html> shell)
//   • NotFound + FatalError route-level fallbacks
//
// SHELL_LESS routing + handleSignOut logic moved with the shell into
// Layout.tsx. Route guards (requireAuth / requireOnboarding) live in
// src/lib/guards.ts and are unchanged.
//
// NOTE: route guards handle 401/428 the SPA-safe way via `throw redirect()`.
// We deliberately do NOT install a global onQueryError that calls
// window.location.assign() — that nukes the React tree, query cache, and
// router history on every auth failure.

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
        {/* Suspense boundary is required for TanStack Router's lazy route
            chunks (file-based code splitting). Reuses the same skeleton
            layout the auth-pending shell already renders — no extra asset. */}
        <Suspense fallback={<ShellSkeleton />}>
          <Shell />
        </Suspense>
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

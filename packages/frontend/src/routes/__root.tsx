import { Suspense, useState } from "react"
import {
  createRootRouteWithContext,
  Link,
  HeadContent,
  Scripts,
  Outlet,
} from "@tanstack/react-router"
import "../index.css"
import { QueryClientProvider } from "@tanstack/react-query"
import { NuqsAdapter } from "nuqs/adapters/tanstack-router"
import { ErrorBoundary } from "../components/ErrorBoundary"
import { queryClient } from "../components/query-client"
import { Toaster } from "@agent-harness/ui"

// Root route — providers + document chrome only.
//
// All app-shell chrome (sidebar, topbar, mobile drawer, ExtensionStatusPill,
// NotificationsBell) lives in src/components/Layout.tsx and is mounted ONLY
// by the /_app layout route (src/routes/_app.tsx) — authed app pages
// (/dashboard, /jobs, /traces, /logs, /memory, /settings). Public/auth/
// onboarding routes (/, /login, /signup, /forgot-password, /onboarding) are
// NOT children of /_app, so they render shell-less through the bare
// <Outlet /> below.
//
// This file keeps only:
//   • Provider tree (ErrorBoundary → QueryClientProvider → Suspense → Outlet)
//   • Toaster (sonner) mounted at the root so any page can fire toasts
//   • RootDocument (the <html> shell)
//   • NotFound + FatalError route-level fallbacks
//
// Route guards (requireAuth / requireOnboarding) live in src/lib/guards.ts
// and are applied at the /_app layout route (requireAuth) + /onboarding.
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
      { name: "color-scheme", content: "light" },
      // Marker for the browser extension's detect.js content script: pages
      // declaring this tag are ours, and only there does the extension
      // announce its presence (dataset.agentHarnessExt) — see
      // extension/detect.js + useExtensionInstalled.
      { name: "agent-harness-site", content: "1" },
    ],
    links: [
      // Fonts (Geist + Open Sans) load via the @import at the top of
      // index.css; these preconnects warm up the font origins.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
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
            chunks (file-based code splitting). The /_app layout route owns
            the ShellSkeleton fallback for authed pages; here we use a plain
            spinner-shaped placeholder so public pages don't flash dashboard
            chrome while their chunk loads. */}
        {/* NuqsAdapter powers URL-backed state (useTabParam in
            src/hooks/use-tab-param.ts). The nuqs TanStack Router adapter is
            experimental and doesn't officially cover TanStack Start yet —
            all reads/writes are contained behind useTabParam so a fallback
            to native validateSearch is a one-file swap. */}
        <NuqsAdapter>
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
          <Toaster richColors position="top-right" />
        </NuqsAdapter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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

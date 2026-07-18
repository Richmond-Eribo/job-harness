import React from "react"
import ReactDOM from "react-dom/client"
import {
  createRouter,
  RouterProvider,
  createRootRoute,
  createRoute,
  createHashHistory,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./index.css"

import { AppLayout } from "./components/AppLayout"
import { LandingPage } from "./routes/LandingPage"
import { LoginPage } from "./routes/LoginPage"
import { SignupPage } from "./routes/SignupPage"
import { OnboardingPage } from "./routes/OnboardingPage"
import { OverviewPage } from "./routes/OverviewPage"
import { JobsPage } from "./routes/JobsPage"
import { TracesPage } from "./routes/TracesPage"
import { TraceDetailPage } from "./routes/TraceDetailPage"
import { LogsPage } from "./routes/LogsPage"
import { MemoryPage } from "./routes/MemoryPage"
import { SettingsPage } from "./routes/SettingsPage"

// Single QueryClient for the app. Default staleTime of 0 means queries refetch
// on focus/window visibility — good for a live dashboard.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
})

// --- Router setup ---
// We use hash history so the SPA works under Workers Assets' SPA fallback
// without server-side route config for every path. The auth/onboarding guards
// run in beforeLoad.

const rootRoute = createRootRoute({
  component: AppLayout,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
})

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  component: SignupPage,
})

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
})

// `/` is the public marketing landing page. The dashboard (Overview) lives at
// `/dashboard`; logged-in users hitting `/` are redirected there by AppLayout.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LandingPage,
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: OverviewPage,
})

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: JobsPage,
})

const tracesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traces",
  component: TracesPage,
})

const traceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traces/$runId",
  component: TraceDetailPage,
})

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: LogsPage,
})

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemoryPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  onboardingRoute,
  dashboardRoute,
  jobsRoute,
  tracesRoute,
  traceDetailRoute,
  logsRoute,
  memoryRoute,
  settingsRoute,
])

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
})

// Register types for `useLoaderData` / `Link` autocompletion.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
)

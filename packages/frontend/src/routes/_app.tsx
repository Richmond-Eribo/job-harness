import { createFileRoute } from "@tanstack/react-router"
import { Shell } from "../components/Layout"
import { requireAuth } from "../lib/guards"

// `/_app` — layout route for the authenticated app shell.
//
// All authed pages (/dashboard, /jobs, /traces, /logs, /memory, /settings)
// live as children of this route so they share:
//   • the dashboard chrome (sidebar + topbar) via <Shell />
//   • a single `requireAuth` guard (no per-route repetition)
//
// Public/auth/onboarding routes (/ , /login, /signup, /forgot-password,
// /onboarding) are NOT children of this route, so they render shell-less —
// the root route renders a bare <Outlet /> for them.
export const Route = createFileRoute("/_app")({
  beforeLoad: requireAuth,
  component: () => <Shell />,
})

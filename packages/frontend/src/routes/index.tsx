import { createFileRoute } from "@tanstack/react-router"
import { LandingPage } from "../pages/LandingPage"
import { redirectIfAuthed } from "../lib/guards"

// `/` — public marketing landing page. Logged-in visitors bounce to the app
// (or /onboarding if they haven't finished setup).
export const Route = createFileRoute("/")({
  component: LandingPage,
  beforeLoad: redirectIfAuthed,
})

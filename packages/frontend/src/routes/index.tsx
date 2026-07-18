import { createFileRoute } from "@tanstack/react-router"
import { LandingPage } from "../pages/LandingPage"

// `/` — public marketing landing page. Logged-in visitors are redirected to
// /dashboard by the guards in __root.tsx's Shell.
export const Route = createFileRoute("/")({
  component: LandingPage,
})

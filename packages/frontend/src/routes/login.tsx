import { createFileRoute } from "@tanstack/react-router"
import { LoginPage } from "../pages/LoginPage"
import { redirectIfAuthed } from "../lib/guards"

// `/login` — public. Email + password sign-in. Logged-in visitors are bounced
// to /dashboard (or /onboarding).
export const Route = createFileRoute("/login")({
  component: LoginPage,
  beforeLoad: redirectIfAuthed,
})

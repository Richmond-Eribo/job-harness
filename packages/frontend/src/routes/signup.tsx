import { createFileRoute } from "@tanstack/react-router"
import { SignupPage } from "../pages/SignupPage"
import { redirectIfAuthed } from "../lib/guards"

// `/signup` — public. Email + password + OTP verification + onboarding. Logged-
// in visitors are bounced to /dashboard (or /onboarding).
export const Route = createFileRoute("/signup")({
  component: SignupPage,
  beforeLoad: redirectIfAuthed,
})

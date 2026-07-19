import { createFileRoute } from "@tanstack/react-router"
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage"
import { redirectIfAuthed } from "../lib/guards"

// `/forgot-password` — public. Two-step OTP reset flow. Logged-in visitors are
// bounced to /dashboard.
export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
  beforeLoad: redirectIfAuthed,
})

import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { LoginPage } from "../pages/LoginPage"
import { redirectIfAuthed } from "../lib/guards"

// `/login` — public. Email + password sign-in. Logged-in visitors are bounced
// to /dashboard (or /onboarding).
//
// Search params:
//   redirect — the URL the user originally requested (set by requireAuth on
//              bounce). On successful sign-in we navigate back there instead
//              of the default /dashboard.
//   reason   — the bounce reason code (session_required | session_check_failed
//              | onboarding_required | unverified). Lets the page surface a
//              contextual banner without a separate flash.
export const Route = createFileRoute("/login")({
  component: LoginPage,
  beforeLoad: redirectIfAuthed,
  validateSearch: z.object({
    redirect: z.string().optional(),
    reason: z.string().optional(),
  }),
})

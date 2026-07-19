import { createFileRoute } from "@tanstack/react-router"
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage"

// `/forgot-password` — public, and deliberately reachable WHILE AUTHED. A user
// who is locked out but still has a valid session cookie in their browser must
// be able to reset their password — that's the whole point of this page. So no
// redirectIfAuthed guard here (unlike /login and /signup).
export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
})

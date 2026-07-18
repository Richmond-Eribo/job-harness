import { createFileRoute } from "@tanstack/react-router"
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage"

// `/forgot-password` — public. Two-step OTP reset flow.
export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
})

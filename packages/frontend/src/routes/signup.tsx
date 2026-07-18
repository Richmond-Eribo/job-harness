import { createFileRoute } from "@tanstack/react-router"
import { SignupPage } from "../pages/SignupPage"

// `/signup` — public. Email + password + OTP verification + onboarding.
export const Route = createFileRoute("/signup")({
  component: SignupPage,
})

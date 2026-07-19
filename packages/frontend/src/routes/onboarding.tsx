import { createFileRoute } from "@tanstack/react-router"
import { OnboardingPage } from "../pages/OnboardingPage"
import { requireOnboarding } from "../lib/guards"

// `/onboarding` — requires a session (can't onboard anonymously). Already-
// onboarded users are bounced to /dashboard so they don't redo the form.
export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
  beforeLoad: requireOnboarding,
})

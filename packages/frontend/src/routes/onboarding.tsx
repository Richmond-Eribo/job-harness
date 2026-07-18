import { createFileRoute } from "@tanstack/react-router"
import { OnboardingPage } from "../pages/OnboardingPage"

// `/onboarding` — onboarding gate. Reached after first signup (and when a
// logged-in user without onboardingComplete hits an app route).
export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
})

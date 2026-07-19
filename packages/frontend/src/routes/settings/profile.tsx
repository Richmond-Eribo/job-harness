import { createFileRoute } from "@tanstack/react-router"
import { ProfilePage } from "../../pages/ProfilePage"
import { requireAuth } from "../../lib/guards"

// `/settings/profile` — the profile editor. This is where the requireProfile
// gate sends users who are missing a first/last name (?required=1 banner).
// It uses requireAuth (not requireProfile) so it stays reachable while the
// profile is incomplete — otherwise the gate would redirect it to itself.
export const Route = createFileRoute("/settings/profile")({
  component: ProfilePage,
  validateSearch: (search: Record<string, unknown>): { required?: "1" } => ({
    required: search.required === "1" ? "1" : undefined,
  }),
  beforeLoad: requireAuth,
})


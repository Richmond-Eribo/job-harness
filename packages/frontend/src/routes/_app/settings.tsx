import { createFileRoute } from "@tanstack/react-router"
import { SettingsPage } from "../../pages/SettingsPage"

// `/settings` — the tabbed settings surface (Profile / LLM Config / Browser &
// Extension / Schedules / Account). `requireAuth` is provided by the parent
// layout route at `routes/_app.tsx`.
//
// `?tab=` is URL state managed by nuqs at runtime (src/hooks/use-tab-param.ts);
// this validateSearch only types the param for <Link search={…}> deep links
// (e.g. ExtensionStatusPill and the Overview preflight link to
// /settings?tab=browser). Runtime parsing/validation lives in useTabParam.
export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  component: SettingsPage,
})

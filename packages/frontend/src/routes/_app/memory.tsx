import { createFileRoute } from "@tanstack/react-router"
import { MemoryPage } from "../../pages/MemoryPage"

// `/memory` — app shell. Agent memory + operator notes editor.
// `requireAuth` is provided by the parent layout route at `routes/_app.tsx`.
export const Route = createFileRoute("/_app/memory")({
  component: MemoryPage,
})

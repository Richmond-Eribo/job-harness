import { createFileRoute } from "@tanstack/react-router"
import { MemoryPage } from "../pages/MemoryPage"
import { requireAuth } from "../lib/guards"

// `/memory` — app shell. Agent memory + operator notes editor.
export const Route = createFileRoute("/memory")({
  component: MemoryPage,
  beforeLoad: requireAuth,
})

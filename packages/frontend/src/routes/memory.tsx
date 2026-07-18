import { createFileRoute } from "@tanstack/react-router"
import { MemoryPage } from "../pages/MemoryPage"

// `/memory` — app shell. Agent memory + operator notes editor.
export const Route = createFileRoute("/memory")({
  component: MemoryPage,
})

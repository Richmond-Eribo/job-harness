// Singleton QueryClient for the app.
//
// Extracted from routes/__root.tsx (Phase 4 cleanup) so it can be imported
// by both the root route (which wraps the tree in QueryClientProvider) and
// Layout.tsx (which clears the cache on sign-out). Previously this lived as
// a `const queryClient = new QueryClient(...)` at the bottom of __root.tsx
// and Layout (then still inlined in __root) closed over it directly — fine
// while it was one file, awkward now that they're split.
//
// Defaults are deliberately conservative: `retry: 1` so a transient blip
// self-heals without blocking the UI, and `staleTime: 0` so refetches happen
// normally (per-hook intervals override this where appropriate).
import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
})

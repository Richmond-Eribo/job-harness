// =============================================================================
// Layout — the HTML shell rendered by Hono's jsxRenderer middleware.
// =============================================================================
// c.render(<Dashboard/>) gets wrapped in <Layout> by the `renderer` middleware
// below. Static assets (CSS/JS) are linked from the Cloudflare [assets] binding
// at /css/* and /js/* — NOT inlined — so they cache independently and the HTML
// payload stays small. The doctype is emitted via the renderer's docType option
// (raw `<!doctype>` is not valid inside JSX).
// =============================================================================

import { jsxRenderer } from "hono/jsx-renderer"
import type { FC, PropsWithChildren } from "hono/jsx"

const Layout: FC<PropsWithChildren> = ({ children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Agent Harness — Dashboard</title>
        <meta
          name="description"
          content="Autonomous AI agent orchestrator dashboard"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Instrument+Serif:ital@1&display=swap"
          rel="stylesheet"
        />
        {/* Static CSS served from the [assets] binding */}
        <link rel="stylesheet" href="/css/dashboard.css" />
      </head>
      <body>
        {children}
        {/* Static client JS served from the [assets] binding, deferred */}
        <script src="/js/dashboard.js" defer></script>
      </body>
    </html>
  )
}

// jsxRenderer wraps every c.render(...) in <Layout>. The doctype is emitted
// once at the top via docType. Routes that return c.json()/c.html() bypass this.
export const renderer = jsxRenderer(
  ({ children }) => <Layout>{children}</Layout>,
  {
    docType: "<!DOCTYPE html>\n",
  },
)

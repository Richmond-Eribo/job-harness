import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

// Vite config for the agent-harness frontend.
//
// DEV: `vite dev` runs on :5173 and proxies /api, /browser, /css, /js to the
// Worker on :8787 (run `wrangler dev` separately). This lets you develop the
// SPA with HMR against the real backend, same-origin via the proxy.
//
// BUILD: outputs static files to ../frontend/dist, which wrangler serves via
// Workers Assets with an SPA fallback (see wrangler.jsonc assets config).
//
// NOTE: we use CODE-BASED routing (createRouter in main.tsx), not TanStack's
// file-based route generator, so the @tanstack/router-plugin Vite plugin is
// intentionally NOT included. Add it back if switching to file-based routes.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/browser": "http://localhost:8787",
      "/css": "http://localhost:8787",
      "/js": "http://localhost:8787",
    },
  },
  build: {
    // Output into the Hono worker's Workers Assets directory under an /app
    // subpath so the Vite bundle coexists with the legacy dashboard's static
    // files without clobbering them. Workers Assets serves from the worker's
    // ./public, so both legacy (/css, /js) and new (/app/*) assets resolve
    // from one place. Path is relative to this package (packages/frontend).
    outDir: "../hono-worker/public/app",
    sourcemap: true,
  },
})

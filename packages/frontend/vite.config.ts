import { defineConfig } from "vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// TanStack Start frontend — a standalone SSR app deployed to Cloudflare
// Workers, separate from the Hono REST API worker. The browser calls the API
// cross-origin (VITE_API_URL) with credentials; the session cookie lives on the
// API origin (SameSite=None; Secure).
//
// Plugin order matches the official start-basic-cloudflare example exactly:
//   tailwindcss → cloudflare → tanstackStart → react
// cloudflare registers the "ssr" Workers environment; tanstackStart wires the
// file-based route generation + the virtual server-entry; react handles JSX.
// resolve.tsconfigPaths picks up the @/* and ~routeTree aliases from tsconfig.
export default defineConfig({
  server: {
    port: 5173,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tailwindcss(), cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), viteReact()],
})

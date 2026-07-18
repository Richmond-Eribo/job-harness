// Better Auth React client — magic-link auth, same-origin.
//
// The client talks to the Worker's /api/auth/* endpoints (mounted in
// src/index.ts). Same-origin so the session cookie rides automatically — no
// Bearer header, no CORS. The magicLinkClient plugin adds the
// sendMagicLinkEmail + other magic-link helpers.
import { createAuthClient } from "better-auth/react"
import { magicLinkClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  // Same-origin: the SPA is served by Workers Assets, so the client and the
  // /api/auth endpoints share an origin. No baseURL needed.
  plugins: [magicLinkClient()],
})

export type Session = Awaited<ReturnType<typeof authClient.useSession>>["data"]

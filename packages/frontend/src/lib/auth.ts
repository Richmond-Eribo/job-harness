// Better Auth React client — email/password + email-OTP, same-origin.
//
// The client talks to the Worker's /api/auth/* endpoints (mounted in
// src/index.ts). Same-origin so the session cookie rides automatically — no
// Bearer header, no CORS. The emailOTPClient plugin adds the OTP helpers
// (sendVerificationOtp, verifyEmail, signInEmailOtp, resetPassword).
import { createAuthClient } from "better-auth/react"
import { emailOTPClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  // Same-origin: the SPA is served by Workers Assets, so the client and the
  // /api/auth endpoints share an origin. No baseURL needed.
  plugins: [emailOTPClient()],
})

export type Session = Awaited<ReturnType<typeof authClient.useSession>>["data"]

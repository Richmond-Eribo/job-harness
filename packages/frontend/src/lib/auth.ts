// Better Auth React client — email/password + email-OTP, CROSS-ORIGIN.
//
// The frontend is now a standalone app on a separate origin from the API
// worker, so the client must point at the API explicitly (VITE_API_URL) and
// send credentials so the SameSite=None session cookie rides along. The
// emailOTPClient plugin adds the OTP helpers (sendVerificationOtp, verifyEmail,
// signInEmailOtp, resetPassword).
import { createAuthClient } from "better-auth/react"
import { emailOTPClient } from "better-auth/client/plugins"

// The API origin, e.g. http://localhost:8787 (dev) or https://api.<host> (prod).
// Empty string falls back to same-origin (the legacy worker-served SPA mode).
export const API_URL = import.meta.env.VITE_API_URL ?? ""

export const authClient = createAuthClient({
  baseURL: API_URL || undefined,
  plugins: [emailOTPClient()],
  fetchOptions: {
    // Send the cross-origin session cookie. The API worker sets
    // Access-Control-Allow-Credentials: true + echoes our origin, so the
    // browser attaches the cookie to these requests.
    credentials: "include",
  },
})

export type Session = Awaited<ReturnType<typeof authClient.useSession>>["data"]

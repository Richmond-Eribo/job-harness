import { useActionState, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"

// Forgot password — two-step flow on one page, mirroring the signup OTP pattern:
//   1. Request: enter email → POST /email-otp/request-password-reset → Resend
//      emails a 6-digit code.
//   2. Reset: enter the code + a new password → POST /email-otp/reset-password
//      → on success, go to /login.
// All helpers come from the emailOTPClient plugin (mounted in lib/auth.ts).
//
// React 19 form actions: a single useActionState branches on the current step.
// `email` stays in React state because both steps + the resend button need it
// and it must persist across the step transition; the OTP/password/confirm
// fields are read from FormData (uncontrolled).
type Step = "request" | "reset"
type ResetState = { error?: string; step: Step; email: string }

export function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")

  const [state, action, pending] = useActionState<ResetState, FormData>(
    async (prev, fd) => {
      // Step 1 (request) and step 2 (reset) share this action; branch on the
      // step carried in the previous state.
      if (prev.step !== "reset") {
        const e = String(fd.get("email") ?? "")
        try {
          const { error: reqError } = await (authClient as any).emailOtp
            .requestPasswordReset({ email: e })
          if (reqError) {
            throw new Error(reqError.message ?? "Request failed")
          }
          setEmail(e)
          return { step: "reset", email: e }
        } catch (err: any) {
          return { step: "request", email: e, error: err.message }
        }
      }

      // Step 2 (reset)
      const otp = String(fd.get("otp") ?? "").trim()
      const password = String(fd.get("password") ?? "")
      const confirm = String(fd.get("confirm") ?? "")
      if (password.length < 8) {
        return { ...prev, error: "Password must be at least 8 characters." }
      }
      if (password !== confirm) {
        return { ...prev, error: "Passwords don't match." }
      }
      try {
        const { error: resetError } = await (authClient as any).emailOtp
          .resetPassword({ email: prev.email, otp, password })
        if (resetError) {
          throw new Error(resetError.message ?? "Reset failed")
        }
        await navigate({ to: "/login" })
        return { ...prev }
      } catch (err: any) {
        return { ...prev, error: err.message }
      }
    },
    { step: "request", email: "" },
  )

  const step = state.step
  const error = state.error
  const resend = async () => {
    if (!email) return
    try {
      const { error: reqError } = await (authClient as any).emailOtp
        .requestPasswordReset({ email })
      if (reqError) throw new Error(reqError.message ?? "Couldn't resend code")
    } catch {
      // best-effort; the user can retry
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <CardDescription>
            {step === "request"
              ? "Enter your email and we'll send a 6-digit code."
              : `Enter the code we sent to ${email} plus a new password.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "request" ? (
            <form action={action} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-email">Email</Label>
                <Input
                  id="fp-email"
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  defaultValue={email}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? "Sending…" : "Send reset code"}
              </Button>
            </form>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-otp">Verification code</Label>
                <Input
                  id="fp-otp"
                  name="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  placeholder="123456"
                  className="text-lg tracking-[0.5em] text-center"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-pw">New password</Label>
                <Input
                  id="fp-pw"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-confirm">Confirm new password</Label>
                <Input
                  id="fp-confirm"
                  name="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? "Resetting…" : "Reset password"}
              </Button>
              <button
                type="button"
                onClick={resend}
                disabled={pending}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Didn't get the code? Resend
              </button>
            </form>
          )}

          {error && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <p className="text-center text-sm text-muted-foreground mt-6">
            Remembered it?{" "}
            <Link to="/login" className="text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

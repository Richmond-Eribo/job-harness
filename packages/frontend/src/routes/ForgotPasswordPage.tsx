import { useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
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
type Step = "request" | "reset"

export function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("request")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [email, setEmail] = useState("")
  const [otp, setOtp] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")

  // ── Step 1: request the reset OTP ──────────────────────────────────────
  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // Cast: the emailOTP client methods aren't reflected in the inferred
      // type (same situation as signUpEmail / signInEmail).
      const { error: reqError } = await (
        authClient as any
      ).emailOtp.requestPasswordReset({ email })
      if (reqError) throw new Error(reqError.message ?? "Request failed")
      setStep("reset")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ── Step 2: reset the password with the OTP ────────────────────────────
  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    try {
      const { error: resetError } = await (
        authClient as any
      ).emailOtp.resetPassword({ email, otp: otp.trim(), password })
      if (resetError) throw new Error(resetError.message ?? "Reset failed")
      navigate({ to: "/login" })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    setError(null)
    setBusy(true)
    try {
      const { error: reqError } = await (
        authClient as any
      ).emailOtp.requestPasswordReset({ email })
      if (reqError) throw new Error(reqError.message ?? "Couldn't resend code")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
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
          {/* ── Step 1: request ───────────────────────────────────────── */}
          {step === "request" ? (
            <form onSubmit={submitRequest} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-email">Email</Label>
                <Input
                  id="fp-email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send reset code"}
              </Button>
            </form>
          ) : (
            // ── Step 2: reset ────────────────────────────────────────
            <form onSubmit={submitReset} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-otp">Verification code</Label>
                <Input
                  id="fp-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={otp}
                  onChange={e =>
                    setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="123456"
                  className="text-lg tracking-[0.5em] text-center"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-pw">New password</Label>
                <Input
                  id="fp-pw"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="fp-confirm">Confirm new password</Label>
                <Input
                  id="fp-confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? "Resetting…" : "Reset password"}
              </Button>
              <button
                type="button"
                onClick={resend}
                disabled={busy}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Didn't get the code? Resend
              </button>
            </form>
          )}

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
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

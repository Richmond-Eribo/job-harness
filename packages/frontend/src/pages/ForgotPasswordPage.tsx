import { useActionState, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, CircleAlert, KeyRound } from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"
import { AuthShowcase } from "../components/AuthShowcase"

type Step = "request" | "reset"
type ResetState = { error?: string; step: Step; email: string }

export function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")

  const [state, action, pending] = useActionState<ResetState, FormData>(
    async (prev, fd) => {
      if (prev.step !== "reset") {
        const e = String(fd.get("email") ?? "")
        try {
          const { error: reqError } = await authClient.emailOtp
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
        const { error: resetError } = await authClient.emailOtp
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
      const { error: reqError } = await authClient.emailOtp
        .requestPasswordReset({ email })
      if (reqError) throw new Error(reqError.message ?? "Couldn't resend code")
    } catch {
      // best-effort
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground animate-fade-in">
      {/* Left 50% Showcase Panel */}
      <AuthShowcase />

      {/* Right 50% Form Area */}
      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-12">
        {/* Top Header Link */}
        <div className="flex items-center justify-between w-full max-w-md mx-auto">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to website
          </Link>
          <div className="text-xs text-muted-foreground">
            Remembered password?{" "}
            <Link to="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </div>
        </div>

        {/* Center Form Container */}
        <div className="w-full max-w-md mx-auto my-auto py-8">
          <div className="mb-6">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 grid place-items-center text-primary mb-4">
              <KeyRound className="size-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {step === "request"
                ? "Enter your email address to receive a verification code."
                : `Enter the 6-digit code sent to ${email} and your new password.`}
            </p>
          </div>

          {step === "request" ? (
            <form action={action} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-email" className="text-xs text-muted-foreground">Email address</Label>
                <Input
                  id="fp-email"
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  defaultValue={email}
                  placeholder="name@example.com"
                  className="h-10"
                />
              </div>
              <Button type="submit" disabled={pending} size="lg" className="mt-1 w-full">
                {pending ? "Sending code…" : "Send Reset Code"}
              </Button>
            </form>
          ) : (
            <form action={action} className="flex flex-col gap-4 animate-slide-up">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-otp" className="text-xs text-muted-foreground">Verification Code</Label>
                <Input
                  id="fp-otp"
                  name="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  placeholder="000000"
                  className="text-xl tracking-[0.5em] text-center font-mono h-12"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-pw" className="text-xs text-muted-foreground">New Password</Label>
                <Input
                  id="fp-pw"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  className="h-10"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-confirm" className="text-xs text-muted-foreground">Confirm New Password</Label>
                <Input
                  id="fp-confirm"
                  name="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  className="h-10"
                />
              </div>
              <Button type="submit" disabled={pending} size="lg" className="mt-1 w-full">
                {pending ? "Resetting…" : "Set New Password"}
              </Button>
              <button
                type="button"
                onClick={resend}
                disabled={pending}
                className="text-xs text-muted-foreground hover:text-foreground text-center transition-colors"
              >
                Didn't get the code? Resend code
              </button>
            </form>
          )}

          {error && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Footer info */}
        <div className="w-full max-w-md mx-auto text-center text-xs text-muted-foreground">
          Protected by Job Agent
        </div>
      </div>
    </div>
  )
}

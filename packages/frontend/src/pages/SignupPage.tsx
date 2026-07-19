import { useActionState, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, CircleAlert, ArrowRight } from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  Label,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"
import { AuthShowcase } from "../components/AuthShowcase"

// Signup — 2 steps on one page:
//   1. Account  — email + password → signUp.email (creates the user + emails OTP)
//   2. Verify   — 6-digit OTP via the segmented input-otp component → verifyEmail
//
// On verify success the user goes straight to /dashboard. The requireProfile
// gate (lib/guards.ts) then bounces them to /settings/profile?required=1 to
// collect their first/last name before they can use the rest of the app.
// There is NO profile step on this page anymore.
type Step = "account" | "verify"
type SignupState = { error?: string }

export function SignupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("account")
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  // Email persists across steps so the verify step can show "sent to {email}"
  // and resend the OTP if needed.
  const [email, setEmail] = useState("")
  const [otp, setOtp] = useState("")

  // ── Step 1: create account → triggers OTP email ────────────────────────
  const [accountState, accountAction, accountPending] = useActionState<
    SignupState,
    FormData
  >(async (_prev, fd) => {
    const e = String(fd.get("email") ?? "")
    const password = String(fd.get("password") ?? "")
    const confirm = String(fd.get("confirm") ?? "")
    if (password.length < 8) {
      return { error: "Password must be at least 8 characters." }
    }
    if (password !== confirm) {
      return { error: "Passwords don't match." }
    }
    try {
      // Use the nested path form (signUp.email) so the client's kebab-case
      // path builder produces /sign-up/email — the server endpoint. The flat
      // signUpEmail() form maps to /sign-up-email (404). sendVerificationOnSignUp
      // + requireEmailVerification means this creates the user (unverified) and
      // emails a 6-digit code; emailVerified stays false until step 2.
      const { error: signUpError } = await authClient.signUp.email({
        email: e,
        password,
        name: e.split("@")[0], // Better Auth requires `name`; placeholder until profile.
      })
      if (signUpError) {
        throw new Error(signUpError.message ?? "Sign-up failed")
      }
      setEmail(e)
      setStep("verify")
      return {}
    } catch (err: any) {
      return { error: err.message }
    }
  }, {})

  // ── Step 2: verify the OTP → straight to dashboard ─────────────────────
  // Takes the code as an arg so the auto-submit-on-6-digits path can pass the
  // freshest value (setState is async; reading `otp` from closure right after
  // setOtp would see the previous value).
  const verify = async (code: string) => {
    if (code.trim().length !== 6) return
    setVerifying(true)
    setVerifyError(null)
    try {
      const { error: err } = await authClient.emailOtp.verifyEmail({
        email,
        otp: code.trim(),
      })
      if (err) throw new Error(err.message ?? "Verification failed")
      // The requireProfile gate on /dashboard redirects to /settings/profile
      // when the user has no first/last name yet — always true here, so this
      // lands them on the profile page to finish setup.
      await navigate({ to: "/dashboard" })
    } catch (err: any) {
      setVerifyError(err.message)
    } finally {
      setVerifying(false)
    }
  }

  const resendOtp = async () => {
    if (!email) return
    try {
      const { error: sendError } = await authClient.emailOtp
        .sendVerificationOtp({ email, type: "email-verification" })
      if (sendError) throw new Error(sendError.message ?? "Couldn't resend code")
    } catch {
      // best-effort; user can retry
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground animate-fade-in">
      <AuthShowcase />

      {/* Right 50% Form Area */}
      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-12 overflow-y-auto">
        {/* Top Header Link */}
        <div className="flex items-center justify-between w-full max-w-md mx-auto mb-6">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to website
          </Link>
          <div className="text-xs text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-foreground hover:underline">
              Sign in
            </Link>
          </div>
        </div>

        <div className="w-full max-w-md mx-auto my-auto py-4">
          {/* ── Step 1: Account ────────────────────────────────────────── */}
          {step === "account" && (
            <div>
              <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight">Create your account</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  We'll email you a 6-digit code to confirm your address.
                </p>
              </div>

              <form action={accountAction} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-email">Email</Label>
                  <Input
                    id="su-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    defaultValue={email}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-pw">Password</Label>
                  <Input
                    id="su-pw"
                    name="password"
                    type="password"
                    required
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-confirm">Confirm password</Label>
                  <Input
                    id="su-confirm"
                    name="confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" disabled={accountPending} className="mt-2">
                  {accountPending ? "Creating…" : "Continue"}
                  {!accountPending && <ArrowRight />}
                </Button>
              </form>

              {accountState.error && (
                <Alert variant="destructive" className="mt-4">
                  <CircleAlert />
                  <AlertDescription>{accountState.error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* ── Step 2: Verify OTP ─────────────────────────────────────── */}
          {step === "verify" && (
            <div>
              <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight">Check your email</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                  It expires in 5 minutes.
                </p>
              </div>

              {/* OTP input — segmented shadcn input-otp, auto-submits on 6 digits */}
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-otp">Verification code</Label>
                  <InputOTP
                    id="su-otp"
                    maxLength={6}
                    value={otp}
                    onChange={(v: string) => {
                      setOtp(v)
                      if (v.length === 6) {
                        // Defer so state flushes before verify reads it; pass
                        // the value explicitly to avoid the stale-closure trap.
                        setTimeout(() => verify(v), 0)
                      }
                    }}
                    containerClassName="justify-start"
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>

                {verifyError && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{verifyError}</AlertDescription>
                  </Alert>
                )}

                <Button onClick={() => verify(otp)} disabled={verifying || otp.length !== 6}>
                  {verifying ? "Verifying…" : "Verify & continue"}
                  {!verifying && <ArrowRight />}
                </Button>

                <button
                  type="button"
                  onClick={resendOtp}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
                >
                  Didn't get the code? Resend
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="w-full max-w-md mx-auto" />
      </div>
    </div>
  )
}

import { useActionState, useRef, useState } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { ArrowLeft, CircleAlert, ArrowRight } from "lucide-react"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
  Label,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"
import { api } from "../lib/api"
import { AuthShowcase } from "../components/AuthShowcase"

// Signup — 2 steps on one page:
//   1. Account  — firstName + lastName + email + password → signUp.email.
//                 The SERVER mints + emails the OTP as part of that request
//                 (worker hooks.after) — the client never sends it itself.
//                 Names are REQUIRED here — there's no separate profile gate
//                 later.
//   2. Verify   — 6-digit OTP via the segmented input-otp component → verifyEmail
//                 → writes names to profile KV → navigate to /onboarding (the
//                 wizard collects profile details, CV, and browser pairing).
type Step = "account" | "verify"
// `nonce` bumps on every completed action. React 19's post-action form reset
// blanks the DOM value of controlled inputs (name/email) while their state is
// unchanged — no re-render restores them, and their `required` constraint then
// silently blocks every resubmit. Rekeying the form on the nonce remounts the
// controls from state after each attempt, restoring the visible values and
// keeping submits flowing.
type SignupState = { error?: string; nonce?: number }

export function SignupPage() {
  const navigate = useNavigate()
  const router = useRouter()
  const [step, setStep] = useState<Step>("account")
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  // OTP attempt tracking — after MAX_OTP_ATTEMPTS failures the backend has
  // already invalidated the code, so further attempts are guaranteed to fail.
  // We surface "request a new code" and lock the input.
  const [attemptCount, setAttemptCount] = useState(0)
  const MAX_OTP_ATTEMPTS = 3

  // Email + names persist across steps: email for the verify-step copy + the
  // OTP verify call; names for the post-verify profile write.
  const [email, setEmail] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [otp, setOtp] = useState("")

  // Ref guard — without it, when a user pastes a complete 6-digit code the
  // onChange can fire verify() once for the paste AND once for the auto-submit
  // check, racing two network requests and burning the OTP attempt budget.
  const verifyingRef = useRef(false)

  // ── P1-4: client-side OTP bombing guard (C5) ──────────────────────────
  // The backend rate-limits /send-verification-otp to 3 per 60s, but an
  // attacker can still spam the signup form itself to mint codes against a
  // victim's email. We keep a localStorage counter keyed by email and refuse
  // to send more than OTP_SEND_CAP (5) codes per OTP_SEND_WINDOW_MS (5 min)
  // per address. The cap is intentionally above the backend's 60s/3 limit so
  // a legitimate user doing Resend → wait → Resend is never blocked.
  const OTP_SEND_CAP = 5
  const OTP_SEND_WINDOW_MS = 5 * 60 * 1000
  function otpSendLogKey(e: string) {
    return `ja:otp-send:${e.trim().toLowerCase()}`
  }
  function readOtpSendLog(e: string): { count: number; windowEnd: number } {
    try {
      const raw = localStorage.getItem(otpSendLogKey(e))
      if (!raw) return { count: 0, windowEnd: 0 }
      const parsed = JSON.parse(raw) as { count: number; windowEnd: number }
      if (
        typeof parsed.count !== "number" ||
        typeof parsed.windowEnd !== "number"
      )
        return { count: 0, windowEnd: 0 }
      return parsed
    } catch {
      return { count: 0, windowEnd: 0 }
    }
  }
  function bumpOtpSendLog(e: string) {
    const now = Date.now()
    const log = readOtpSendLog(e)
    const fresh = now > log.windowEnd ? { count: 0, windowEnd: 0 } : log
    const next = {
      count: fresh.count + 1,
      windowEnd: fresh.count === 0 ? now + OTP_SEND_WINDOW_MS : fresh.windowEnd,
    }
    try {
      localStorage.setItem(otpSendLogKey(e), JSON.stringify(next))
    } catch {
      /* storage disabled — fail open, backend still rate-limits */
    }
    return next
  }
  function otpSendBlocked(e: string): {
    blocked: boolean
    remainingMs?: number
  } {
    const log = readOtpSendLog(e)
    if (log.count >= OTP_SEND_CAP && Date.now() < log.windowEnd) {
      return { blocked: true, remainingMs: log.windowEnd - Date.now() }
    }
    return { blocked: false }
  }

  // ── Step 1: create account → triggers OTP email ────────────────────────
  const [accountState, accountAction, accountPending] = useActionState<
    SignupState,
    FormData
  >(async (_prev, fd) => {
    // Every terminal return carries a fresh nonce — see SignupState.
    const fail = (error: string): SignupState => ({
      error,
      nonce: Date.now(),
    })
    const fn = String(fd.get("firstName") ?? "").trim()
    const ln = String(fd.get("lastName") ?? "").trim()
    // P2-1: trim email (a leading space from paste/autocap silently breaks
    // both the signup row and the OTP send).
    const e = String(fd.get("email") ?? "").trim()
    const password = String(fd.get("password") ?? "")
    const confirm = String(fd.get("confirm") ?? "")
    if (!fn || !ln) {
      return fail("First name and last name are required.")
    }
    // P3-6/M3 defense-in-depth: basic shape check so a malformed email doesn't
    // round-trip to the server. The real authority is Better Auth.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return fail("Please enter a valid email address.")
    }
    if (password.length < 8) {
      return fail("Password must be at least 8 characters.")
    }
    if (password !== confirm) {
      return fail("Passwords don't match.")
    }
    // C5: pre-flight the client-side bombing guard BEFORE sending the OTP.
    const guard = otpSendBlocked(e)
    if (guard.blocked) {
      const mins = Math.ceil((guard.remainingMs ?? 0) / 60_000)
      return fail(
        `Too many verification codes sent to this address. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
      )
    }
    try {
      // Use the nested path form (signUp.email) so the client's kebab-case
      // path builder produces /sign-up/email — the server endpoint. The flat
      // signUpEmail() form maps to /sign-up-email (404).
      //
      // `name` is the D1 user.name column (the session display name + what the
      // app shell shows in the sidebar). We pass "First Last" so it's right
      // from the moment the account exists.
      //
      // Email uniqueness is enforced: D1 has a UNIQUE constraint on user.email,
      // and Better Auth's signUpEmail detects a pre-existing email and (because
      // requireEmailVerification is on) deliberately returns a 200 with a
      // synthetic user object — an anti-enumeration measure so an attacker
      // can't learn which emails are registered. No second row is ever created.
      //
      // The SERVER mints + emails the OTP as part of this ONE request (the
      // worker's hooks.after owns the send — see its auth.ts). The client does
      // NOT call sendVerificationOtp here: that separate request was the
      // double-send bug (a duplicate form submit ran it twice, and the
      // synthetic-200 path let the second run sail through). The server also
      // enforces a 30s send cooldown, so the verify step's Resend button is
      // idempotent.
      const { error: signUpError } = await authClient.signUp.email({
        email: e,
        password,
        name: `${fn} ${ln}`.trim(),
      })
      if (signUpError) {
        throw new Error(signUpError.message ?? "Sign-up failed")
      }

      // The signup request triggered a server-side send — count it toward the
      // client-side bombing cap like the old explicit send did.
      bumpOtpSendLog(e)

      setEmail(e)
      setFirstName(fn)
      setLastName(ln)
      setOtp("")
      setAttemptCount(0)
      setStep("verify")
      toast.success("Verification code sent", {
        description: `Sent to ${e} — check your inbox (and spam folder).`,
      })
      return {}
    } catch (err: any) {
      return fail(err.message)
    }
  }, {})

  // ── Step 2: verify the OTP → write names → dashboard ───────────────────
  // Takes the code as an arg so the auto-submit-on-6-digits path can pass the
  // freshest value (setState is async; reading `otp` from closure right after
  // setOtp would see the previous value).
  const verify = async (code: string) => {
    if (code.trim().length !== 6) return
    // P1-3: refuse to fire a second verify while one is in flight. Without
    // this, a paste dispatches both the onChange verify AND a parallel one
    // from the auto-submit path; both would race, and BOTH would burn an OTP
    // attempt even though only one returned first. The backend invalidates
    // the code after 3 total attempts regardless of which succeeded, so we
    // must never double-fire.
    if (verifyingRef.current) return
    verifyingRef.current = true
    setVerifying(true)
    setVerifyError(null)
    try {
      const { error: err } = await authClient.emailOtp.verifyEmail({
        email,
        otp: code.trim(),
      })
      if (err) {
        const nextAttempts = attemptCount + 1
        setAttemptCount(nextAttempts)
        // Map a few common Better Auth email-OTP error codes to copy.
        const code = (err as { code?: string }).code
        const msg =
          code === "OTP_ATTEMPT_EXCEEDED"
            ? "Too many incorrect attempts — this code is no longer valid. Please request a new one."
            : (err.message ?? "Verification failed")
        throw new Error(msg)
      }
      toast.success("Email verified")
      // M9/M13: profile write is OPTIONAL. The names are already on the D1
      // user.name row from signUp.email (which sets it as the Better Auth
      // `name` field). This PUT exists only to populate the profile KV used
      // by the profile/settings UI. If it fails, we surface a non-blocking
      // toast (M9) instead of silently swallowing — the user should know the
      // names might not show in Settings until they edit them.
      try {
        await api.put("/profile", { firstName, lastName })
      } catch (profileErr: any) {
        toast.warning("Profile sync failed", {
          description:
            "Your account is created, but the names didn't sync to your profile yet. You can set them later in Settings.",
        })
        // Intentionally non-fatal — proceed to /dashboard regardless.
        void profileErr
      }
      // NEW PATTERN: call router.invalidate() so every route's beforeLoad
      // (including the new fetchSession server function in lib/guards.ts)
      // re-runs against the freshly-set session cookie. The router then
      // resolves the authenticated state SERVER-SIDE — there's no client
      // cache to warm and no /login flash.
      await router.invalidate()
      // L2: clear the OTP input on success so a navigation that fails to
      // resolve doesn't show a stale verified code in the field.
      setOtp("")
      // Fresh signups go through the onboarding wizard (profile → CV →
      // connect browser) — onboardingComplete stays 0 until the wizard's
      // POST /api/onboarding completes it. Navigating to /dashboard here
      // would just bounce through the guard to /onboarding anyway.
      await navigate({ to: "/onboarding", replace: true })
    } catch (err: any) {
      setVerifyError(err.message)
      toast.error("Verification failed", { description: err.message })
      // Clear the field on failure so the user types a fresh code rather than
      // editing a rejected one.
      setOtp("")
    } finally {
      verifyingRef.current = false
      setVerifying(false)
    }
  }

  const resendOtp = async () => {
    if (!email) return
    if (verifyingRef.current || resending) return
    // C5: client-side bombing guard on resend too.
    const guard = otpSendBlocked(email)
    if (guard.blocked) {
      const mins = Math.ceil((guard.remainingMs ?? 0) / 60_000)
      toast.error("Too many codes sent", {
        description: `Please wait ${mins} minute${mins === 1 ? "" : "s"} before requesting another.`,
      })
      return
    }
    setResending(true)
    try {
      const { error: sendError } =
        await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "email-verification",
        })
      if (sendError)
        throw new Error(sendError.message ?? "Couldn't resend code")
      bumpOtpSendLog(email)
      // L3: clear any partially-entered code so the user starts the new code
      // fresh — stale digits from a previous (failed) attempt are a common
      // source of double-failures.
      setOtp("")
      setAttemptCount(0)
      setVerifyError(null)
      toast.success("Verification code sent", {
        description: `Sent to ${email} — check your inbox (and spam folder).`,
      })
    } catch (err: any) {
      toast.error("Couldn't resend the code", { description: err?.message })
    } finally {
      setResending(false)
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
                <h1 className="text-3xl font-bold tracking-tight">
                  Create your account
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  We'll email you a 6-digit code to confirm your address.
                </p>
              </div>

              <form
                action={accountAction}
                // Rekeyed per completed attempt (SignupState.nonce) so the
                // controlled inputs remount from state after React's
                // post-action form reset — see the type comment above.
                key={accountState?.nonce ?? "initial"}
                className="flex flex-col gap-4"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="su-first">First name</Label>
                    <Input
                      id="su-first"
                      name="firstName"
                      required
                      autoComplete="given-name"
                      // P3-1/M4: controlled input so the value survives a
                      // validation error (previous defaultValue reset to empty
                      // on re-render, forcing the user to retype everything).
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="su-last">Last name</Label>
                    <Input
                      id="su-last"
                      name="lastName"
                      required
                      autoComplete="family-name"
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-email">Email</Label>
                  <Input
                    id="su-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
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
                <Button
                  type="submit"
                  disabled={accountPending}
                  className="mt-2"
                >
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
                <h1 className="text-3xl font-bold tracking-tight">
                  Check your email
                </h1>
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
                    // H9: lock the input while a verify is in flight so the
                    // user can't paste/replace the codependencies mid-request
                    // and trigger a second auto-submit. Also locked when the
                    // attempt cap is hit (the code is dead until resend).
                    disabled={verifying || attemptCount >= MAX_OTP_ATTEMPTS}
                    onChange={(v: string) => {
                      setOtp(v)
                      // P1-3: call verify() synchronously. The previous
                      // setTimeout(() => verify(v), 0) made the verify fire
                      // AFTER the next render tick — so if a user typed the
                      // 6th digit and immediately backspaced, the (now-stale)
                      // 6-digit value was still submitted. Calling directly
                      // plus verifyingRef closes the race.
                      if (v.length === 6) {
                        verify(v)
                      }
                    }}
                    containerClassName="justify-start"
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup>
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>

                {/* H8: hard attempt cap. After MAX_OTP_ATTEMPTS the backend
                     has invalidated the code; further attempts always fail.
                     Surface a clear "request a new code" message and rely on
                     the Resend button below (which resets the counter). */}
                {attemptCount >= MAX_OTP_ATTEMPTS && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>
                      Too many incorrect attempts — this code is no longer
                      valid. Please request a new code below.
                    </AlertDescription>
                  </Alert>
                )}
                {verifyError && attemptCount < MAX_OTP_ATTEMPTS && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{verifyError}</AlertDescription>
                  </Alert>
                )}

                {/* M7: this button is the retry entrypoint after a failed
                     attempt that DIDN'T hit the cap. Disabled while verifying
                     or when the input is empty/short, or when the cap is hit
                     (the user must Resend instead). */}
                <Button
                  onClick={() => verify(otp)}
                  disabled={
                    verifying ||
                    otp.length !== 6 ||
                    attemptCount >= MAX_OTP_ATTEMPTS
                  }
                >
                  {verifying ? "Verifying…" : "Verify & continue"}
                  {!verifying && <ArrowRight />}
                </Button>

                <button
                  type="button"
                  onClick={resendOtp}
                  // H10: resending state on the resend button as well, so the
                  // user can't fire several sends in a row. Also disabled
                  // during an in-flight verify to avoid replacing a code the
                  // client is currently trying to validate.
                  disabled={resending || verifying}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {resending
                    ? "Resending…"
                    : attemptCount >= MAX_OTP_ATTEMPTS
                      ? "Didn't get a working code? Resend code"
                      : "Didn't get the code? Resend"}
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

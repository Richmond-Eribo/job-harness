import { useActionState, useState } from "react"
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { toast } from "sonner"
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
  Separator,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"

// Email + password sign-in. On success calls router.invalidate() (which
// re-runs every route's beforeLoad, including the new server-fn session fetch)
// before navigating to the `?redirect=` URL (or `/dashboard`). Because the
// session is now resolved SERVER-SIDE during navigation, there's no
// client-cache to warm and no /login flash — the router simply re-evaluates
// the authenticated state with the freshly-set cookie.
//
// Error handling: Better Auth returns a `code` on the error object. We branch
// on it so the user gets an actionable message:
//   EMAIL_NOT_VERIFIED       → "verify your email" + a Resend code button
//   INVALID_EMAIL_OR_PASSWORD → the generic message (don't reveal which is wrong)
type LoginState = {
  errorCode?: string
  errorMessage?: string
  unverifiedEmail?: string
}

/**
 * Decode the `?redirect=` search param into a safe in-app path. Returns null
 * if the value is absent, not a string, an external URL, or a protocol-relative
 * URL (`//evil.com`) — defense against open-redirect via the query string.
 */
function safeRedirect(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null
  // Must start with a single slash and NOT `//` (protocol-relative).
  if (!raw.startsWith("/") || raw.startsWith("//")) return null
  // Disallow backslashes (some browsers treat them as slashes).
  if (raw.includes("\\")) return null
  return raw
}

export function LoginPage() {
  const navigate = useNavigate()
  const router = useRouter()
  const [resending, setResending] = useState(false)
  const search = useSearch({ from: "/login" }) as {
    redirect?: string
    reason?: string
  }

  const [state, action, pending] = useActionState<LoginState, FormData>(
    async (_prev, fd) => {
      // Trim EVERYWHERE — mobile autocaps + paste often leave a leading space.
      const email = String(fd.get("email") ?? "").trim()
      const password = String(fd.get("password") ?? "")
      // Use the nested path form (signIn.email) so the client's kebab-case
      // path builder produces /sign-in/email — the server endpoint. The flat
      // signInEmail() form would map to /sign-in-email (404).
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      })
      if (signInError) {
        // Prefer the machine code; fall back to the human message.
        const code = (signInError as { code?: string }).code
        const message = signInError.message ?? "Sign-in failed"
        return {
          errorCode: code,
          errorMessage:
            code === "EMAIL_NOT_VERIFIED"
              ? "Please verify your email before signing in. Check your inbox (and spam folder) for the 6-digit code."
              : message,
          unverifiedEmail: code === "EMAIL_NOT_VERIFIED" ? email : undefined,
        }
      }
      // Signed in. The session cookie is now set on the API origin; the next
      // navigation will resolve it server-side via the fetchSession server
      // function in route beforeLoad. We call router.invalidate() FIRST so
      // the router re-runs every beforeLoad against the fresh cookie state,
      // THEN navigate. This is the documented TanStack Start pattern and it
      // eliminates the old /login flash entirely — there is no client cache
      // to warm because the session is never stored in React state.
      await router.invalidate()
      toast.success("Signed in")
      const dest = safeRedirect(search.redirect) ?? "/dashboard"
      await navigate({ to: dest, replace: true })
      return {}
    },
    {},
  )

  // Resend the OTP for the EMAIL_NOT_VERIFIED case. Uses the email the user
  // just tried to sign in with (captured in state.unverifiedEmail).
  const resendVerification = async () => {
    if (!state.unverifiedEmail) return
    setResending(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: state.unverifiedEmail,
        type: "email-verification",
      })
      if (error) throw new Error(error.message ?? "Couldn't resend code")
      toast.success("Verification code sent", {
        description: `Sent to ${state.unverifiedEmail}`,
      })
    } catch (err: any) {
      toast.error("Couldn't resend the code", { description: err?.message })
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4 animate-fade-in">
      {/* Brand mark */}
      <div className="mb-6 flex flex-col items-center gap-2">
        <span
          className="size-10 rounded-xl bg-primary grid place-items-center text-primary-foreground text-lg font-bold"
          aria-hidden
        >
          J
        </span>
        <span className="text-xs text-muted-foreground font-mono tracking-wider uppercase">
          Job Agent
        </span>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">
            Welcome back
          </CardTitle>
          <CardDescription>Sign in to your job-search agent.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Contextual banner — explains why the user landed here. */}
          {search.reason === "session_check_failed" && (
            <Alert className="mb-4">
              <CircleAlert className="size-4" />
              <AlertDescription>
                We couldn't confirm your session. Please sign in again.
              </AlertDescription>
            </Alert>
          )}
          {search.reason === "session_required" && !state.errorMessage && (
            <Alert className="mb-4">
              <CircleAlert className="size-4" />
              <AlertDescription>Please sign in to continue.</AlertDescription>
            </Alert>
          )}
          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" className="text-xs text-muted-foreground">
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="password"
                  className="text-xs text-muted-foreground"
                >
                  Password
                </Label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" disabled={pending} className="mt-1">
              {pending ? "Signing in…" : "Sign in"}
            </Button>

            {state.errorMessage && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertDescription>
                  {state.errorMessage}
                  {state.errorCode === "EMAIL_NOT_VERIFIED" && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="ml-1 h-auto p-0 align-baseline text-destructive underline"
                      onClick={resendVerification}
                      disabled={resending || !state.unverifiedEmail}
                    >
                      {resending ? "Sending…" : "Resend code"}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </form>

          <Separator className="my-6" />

          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link
              to="/signup"
              className="text-primary hover:underline font-medium"
            >
              Create an account
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

import { useActionState } from "react"
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
  Separator,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"

// Email + password sign-in, as a React 19 form action. The action reads fields
// from FormData (uncontrolled inputs), calls signInEmail, and on success
// navigates to /dashboard — the beforeLoad guard there will bounce to
// /onboarding if the user hasn't completed setup. (Signup with OTP is /signup;
// forgot-password is /forgot-password.)
type LoginState = { error?: string }

export function LoginPage() {
  const navigate = useNavigate()

  const [state, action, pending] = useActionState<LoginState, FormData>(
    async (_prev, fd) => {
      const email = String(fd.get("email") ?? "")
      const password = String(fd.get("password") ?? "")
      try {
        // Use the nested path form (signIn.email) so the client's kebab-case
        // path builder produces /sign-in/email — the server endpoint. The
        // flat signInEmail() form would map to /sign-in-email (404).
        const { error: signInError } = await authClient.signIn.email({
          email,
          password,
        })
        if (signInError) {
          throw new Error(signInError.message ?? "Sign-in failed")
        }
        // Navigate to /dashboard; the route's beforeLoad guard will send a
        // not-yet-onboarded user to /onboarding.
        await navigate({ to: "/dashboard" })
        return {}
      } catch (err: any) {
        return { error: err.message }
      }
    },
    {},
  )

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

            {state.error && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertDescription>{state.error}</AlertDescription>
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

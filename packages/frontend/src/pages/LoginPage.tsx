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
        // Cast: signInEmail is a core email/password method (enabled server-
        // side); the client's type inference only reflects plugin methods.
        const { error: signInError } = await (authClient as any).signInEmail({
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
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>Sign in to your job-search agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
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
            <Button type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>

            {state.error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
          </form>

          <p className="text-center text-sm text-muted-foreground mt-6">
            New here?{" "}
            <Link to="/signup" className="text-primary hover:underline">
              Create an account
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

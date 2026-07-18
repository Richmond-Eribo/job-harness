import { useState } from "react"
import { authClient } from "../lib/auth"
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

export function LoginPage() {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; devUrl?: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus({ kind: "sending" })
    try {
      // Better Auth magic-link sign-in. The documented client helper is
      // `signInMagicLink` — the proxy maps it to POST /api/auth/sign-in/magic-link
      // (the path the server registers at
      // node_modules/better-auth/dist/plugins/magic-link/index.mjs:41).
      // Do NOT use `magicLink.sendMagicLinkEmail` — the proxy kebab-cases that
      // to /magic-link/send-magic-link-email, which doesn't exist → 404.
      // Cast: TS can't infer the method without co-located server plugin types.
      const { data, error } = await (authClient as any).signInMagicLink({
        email,
        callbackURL: "/",
      })
      if (error) throw new Error(error.message ?? "Failed to send link")
      // In dev (no Resend), the backend logs the link and may return it in the
      // response. Surface it so local dev can click through.
      const devUrl = (data as any)?.url
      setStatus({ kind: "sent", devUrl })
    } catch (err: any) {
      setStatus({ kind: "error", message: err.message })
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Sign in</CardTitle>
          <CardDescription>
            Enter your email and we'll send a magic link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={status.kind === "sending"}>
              {status.kind === "sending" ? "Sending…" : "Send magic link"}
            </Button>

            {status.kind === "sent" && (
              <div className="p-3 rounded-lg bg-primary/10 text-primary text-sm break-all">
                {status.devUrl ? (
                  <>
                    Dev mode —{" "}
                    <a href={status.devUrl} className="underline">
                      click this link
                    </a>{" "}
                    to sign in.
                  </>
                ) : (
                  "Check your email for the sign-in link."
                )}
              </div>
            )}
            {status.kind === "error" && (
              <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                {status.message}
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

import { useState } from "react"
import { authClient } from "../lib/auth"

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
      // Better Auth magic-link: sends an email with a link. callbackURL is
      // where the user lands after clicking the link.
      // Cast: the client plugin infers its methods from the server plugin's
      // types, which aren't co-located here, so TS doesn't see
      // sendMagicLinkEmail (it works at runtime).
      const { data, error } = await (authClient as any).magicLink.sendMagicLinkEmail({
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
    <div className="flex items-center justify-center min-h-screen bg-ink-950">
      <form
        onSubmit={submit}
        className="bg-ink-900 p-10 rounded-2xl w-full max-w-sm shadow-2xl"
      >
        <h1 className="text-2xl font-bold mb-2">Sign in</h1>
        <p className="text-sm text-ink-500 mb-6">
          Enter your email and we'll send a magic link.
        </p>
        <label className="block text-sm text-ink-300 mb-1.5">Email</label>
        <input
          type="email"
          required
          autoFocus
          autoComplete="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg bg-ink-950 border border-ink-800 text-white mb-4 focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={status.kind === "sending"}
          className="w-full py-2.5 rounded-lg bg-accent text-white font-semibold hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {status.kind === "sending" ? "Sending…" : "Send magic link"}
        </button>

        {status.kind === "sent" && (
          <div className="mt-4 p-3 rounded-lg bg-emerald-950 text-emerald-300 text-sm break-all">
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
          <div className="mt-4 p-3 rounded-lg bg-red-950 text-red-300 text-sm">
            {status.message}
          </div>
        )}
      </form>
    </div>
  )
}

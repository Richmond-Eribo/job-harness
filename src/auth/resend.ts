// =============================================================================
// Resend email transport for Better Auth magic links.
// =============================================================================
// Thin wrapper so the sendMagicLink callback is mockable/testable and the dev
// path (no RESEND_API_KEY) stays explicit: the link is logged to the console
// and returned via an out-of-band channel the caller can surface for local dev.
// =============================================================================
import { Resend } from "resend"

export interface SendMagicLinkArgs {
  to: string
  /** The absolute magic-link URL the user must click. */
  url: string
  /** The bare token (useful for a short "code" form factor). */
  token: string
}

export interface SendMagicLinkResult {
  sent: boolean
  /** When sending was skipped (dev with no key), this carries the URL so the
   * caller can surface it for click-through testing. Null when actually sent. */
  devUrl: string | null
}

/**
 * Send a magic-link email via Resend. When `apiKey` is empty (local dev), this
 * does NOT send — it logs the link and returns it so the auth route can expose
 * it through a dev-only response header. This keeps the full flow testable with
 * zero provider setup.
 */
export async function sendMagicLinkEmail(
  args: SendMagicLinkArgs,
  opts: { apiKey?: string; from?: string },
): Promise<SendMagicLinkResult> {
  const { to, url } = args
  const { apiKey, from } = opts

  if (!apiKey || !from) {
    // Dev path — never send real email. The caller surfaces `devUrl`.
    console.log(
      `[auth][magic-link] dev mode (no RESEND_API_KEY / MAIL_FROM). ` +
        `Magic link for ${to}: ${url}`,
    )
    return { sent: false, devUrl: url }
  }

  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Your sign-in link",
    html: magicLinkHtml(url),
    text: `Sign in to your account:\n\n${url}\n\nThis link expires in 5 minutes.`,
  })
  if (error) {
    // Surface the provider error so the auth callback fails loudly rather than
    // silently swallowing a magic link that never arrived.
    throw new Error(`Resend send failed: ${error.message}`)
  }
  return { sent: true, devUrl: null }
}

function magicLinkHtml(url: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin-top:0">Sign in</h2>
    <p style="color:#475569">Click the button below to sign in to your account. This link expires in 5 minutes and can only be used once.</p>
    <p style="margin:32px 0">
      <a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Sign in</a>
    </p>
    <p style="color:#94a3b8;font-size:13px">If you didn't request this link, you can ignore this email.</p>
    <p style="color:#94a3b8;font-size:13px;word-break:break-all">Or paste this link: ${url}</p>
  </body>
</html>`
}

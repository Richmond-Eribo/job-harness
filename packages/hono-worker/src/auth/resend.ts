// =============================================================================
// Resend email transport for Better Auth OTP verification codes.
// =============================================================================
// Sends the 6-digit OTP code via Resend. There is NO dev-mode console fallback:
// RESEND_API_KEY and MAIL_FROM MUST be set, otherwise this throws loudly so
// misconfiguration surfaces immediately rather than silently swallowing codes.
// (Verify your sending domain at https://resend.com/domains first.)
// =============================================================================
import { Resend } from "resend"

export interface SendOtpArgs {
  to: string
  /** The 6-digit one-time code. */
  otp: string
}

/**
 * Send an OTP verification email via Resend. Throws if RESEND_API_KEY or
 * MAIL_FROM is missing — by design, so a missing key is obvious at the first
 * signup rather than a silent no-op.
 */
export async function sendOtpEmail(
  args: SendOtpArgs,
  opts: { apiKey?: string; from?: string },
): Promise<void> {
  const { to, otp } = args
  const { apiKey, from } = opts

  const missing = [!apiKey && "RESEND_API_KEY", !from && "MAIL_FROM"]
    .filter(Boolean)
    .join(" + ")
  if (missing) {
    throw new Error(
      `[auth][otp] cannot send verification email to ${to}: missing ${missing}. ` +
        `Set these in .dev.vars (local) or via \`wrangler secret put\` (prod), ` +
        `and verify your sending domain at resend.com/domains.`,
    )
  }

  const resend = new Resend(apiKey!)
  const { error } = await resend.emails.send({
    from: from!,
    to,
    subject: `Your verification code: ${otp}`,
    html: otpHtml(otp),
    text: `Your verification code is ${otp}. It expires in 5 minutes.`,
  })
  if (error) {
    // Surface the provider error so the auth callback fails loudly rather than
    // silently swallowing a code that never arrived.
    throw new Error(`Resend send failed: ${error.message}`)
  }
}

function otpHtml(otp: string): string {
  // Large, scannable code. Branded to match the app's slate/indigo dark theme.
  return `<!DOCTYPE html>
<html>
  <body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin-top:0">Verify your email</h2>
    <p style="color:#475569">Use the code below to finish setting up your account. It expires in 5 minutes.</p>
    <p style="margin:32px 0;text-align:center">
      <span style="display:inline-block;letter-spacing:0.5em;font-size:40px;font-weight:700;color:#3b82f6;background:#eff6ff;padding:20px 28px;border-radius:12px">${otp}</span>
    </p>
    <p style="color:#94a3b8;font-size:13px">If you didn't create an account, you can ignore this email.</p>
  </body>
</html>`
}

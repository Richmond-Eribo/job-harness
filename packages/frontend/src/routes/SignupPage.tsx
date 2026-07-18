import { useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
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
import { authClient } from "../lib/auth"
import { api } from "../lib/api"

// Single-page, sectioned signup:
//   1. Account  — email + password → signUpEmail (creates the user, triggers OTP)
//   2. Verify   — 6-digit OTP → verifyEmail (marks email verified + auto-signs-in)
//   3. Profile  — career fields + CV → POST /api/onboarding (flips onboardingComplete)
//   4. Done     → navigate to /dashboard
//
// Steps 2 and 3 are revealed progressively; the user can't reach them until the
// prior step succeeds. All auth goes through the Better Auth client (same-origin),
// so the session cookie is set automatically on verify.
type Step = "account" | "verify" | "profile"

export function SignupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("account")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Account fields
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")

  // OTP field
  const [otp, setOtp] = useState("")

  // Profile fields (kept in one object so submit is a single POST)
  const [profile, setProfile] = useState<Record<string, string>>({})
  const [cvFile, setCvFile] = useState<File | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setProfile(p => ({ ...p, [k]: e.target.value }))

  // ── Step 1: create account → triggers OTP email ────────────────────────
  const submitAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    try {
      // sendVerificationOnSignUp + requireEmailVerification: this creates the
      // user (unverified) and emails a 6-digit code. emailVerified stays false
      // until step 2, so sign-in is blocked until the OTP is confirmed.
      // Cast: signUpEmail is a core email/password method (enabled server-side)
      // but the client's type inference only reflects plugin methods.
      const { error: signUpError } = await (authClient as any).signUpEmail({
        email,
        password,
        name: email.split("@")[0], // Better Auth requires `name`; derive a default.
      })
      if (signUpError) throw new Error(signUpError.message ?? "Sign-up failed")
      setStep("verify")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ── Step 2: verify the OTP ─────────────────────────────────────────────
  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (otp.trim().length !== 6) {
      setError("Enter the 6-digit code from your email.")
      return
    }
    setBusy(true)
    try {
      const { error: verifyError } = await (authClient as any).emailOtp.verifyEmail({
        email,
        otp: otp.trim(),
      })
      if (verifyError) throw new Error(verifyError.message ?? "Verification failed")
      setStep("profile")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const resendOtp = async () => {
    setError(null)
    setBusy(true)
    try {
      const { error: sendError } = await (authClient as any).emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      })
      if (sendError) throw new Error(sendError.message ?? "Couldn't resend code")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ── Step 3: career profile + CV → finish ───────────────────────────────
  const submitProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // 1. Upload CV to R2 if selected (reuses the existing onboarding-exempt route).
      if (cvFile) {
        const upRes = await fetch(
          `/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
          { method: "POST", headers: { "Content-Type": cvFile.type }, body: cvFile },
        )
        if (!upRes.ok) throw new Error("CV upload failed")
      }

      // 2. Save profile + flip onboardingComplete. The endpoint allowlists the
      //    keys it accepts; extras are dropped server-side.
      await api.post("/onboarding", {
        email,
        ...profile,
      })
      navigate({ to: "/dashboard" })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-xl">
        {/* Step indicator */}
        <ol className="flex items-center justify-center gap-2 mb-8 text-xs text-muted-foreground">
          {(["account", "verify", "profile"] as Step[]).map((s, i) => {
            const active = step === s
            const done = STEP_ORDER[step] > STEP_ORDER[s]
            return (
              <li key={s} className="flex items-center gap-2">
                <span
                  className={`size-6 rounded-full flex items-center justify-center border ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : done
                        ? "bg-secondary text-foreground border-border"
                        : "border-border"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className={active ? "text-foreground" : ""}>{LABELS[s]}</span>
                {i < 2 && <span className="w-8 h-px bg-border" />}
              </li>
            )
          })}
        </ol>

        {/* ── Step 1: Account ────────────────────────────────────────── */}
        {(step === "account" || step === "verify") && (
          <Card className={step === "verify" ? "opacity-60 pointer-events-none" : ""}>
            <CardHeader>
              <CardTitle>Create your account</CardTitle>
              <CardDescription>
                We'll email you a 6-digit code to confirm your address.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitAccount} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-email">Email</Label>
                  <Input
                    id="su-email"
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
                    type="password"
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-confirm">Confirm password</Label>
                  <Input
                    id="su-confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Continue"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Verify OTP ─────────────────────────────────────── */}
        {step === "verify" && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Verify your email</CardTitle>
              <CardDescription>
                Enter the 6-digit code we sent to <strong>{email}</strong>. It
                expires in 5 minutes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitOtp} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-otp">Verification code</Label>
                  <Input
                    id="su-otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    className="text-lg tracking-[0.5em] text-center"
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Verifying…" : "Verify & continue"}
                </Button>
                <button
                  type="button"
                  onClick={resendOtp}
                  disabled={busy}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Didn't get the code? Resend
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Career profile ─────────────────────────────────── */}
        {step === "profile" && (
          <Card>
            <CardHeader>
              <CardTitle>Power up your agent</CardTitle>
              <CardDescription>
                The richer your profile, the better the agent targets roles for
                you. You can edit everything later in Settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitProfile} className="flex flex-col gap-6">
                {/* Basics */}
                <Section title="Basics">
                  <Field label="Full name" name="fullName" value={profile.fullName} onChange={set("fullName")} required />
                  <Field label="Phone (optional)" name="phone" value={profile.phone} onChange={set("phone")} />
                  <Field label="Location" name="location" value={profile.location} onChange={set("location")} placeholder="e.g. London, UK" />
                </Section>

                {/* Seniority */}
                <Section title="Experience">
                  <SelectField
                    label="Seniority"
                    name="seniority"
                    value={profile.seniority ?? ""}
                    onChange={set("seniority")}
                    options={["", "Junior", "Mid", "Senior", "Staff", "Principal"]}
                  />
                  <Field label="Years of experience" name="yearsExperience" value={profile.yearsExperience} onChange={set("yearsExperience")} placeholder="e.g. 7" type="number" />
                </Section>

                {/* Target role */}
                <Section title="What you're looking for">
                  <Field label="Target roles" name="targetRoles" value={profile.targetRoles} onChange={set("targetRoles")} placeholder="e.g. Senior TypeScript Engineer" />
                  <Field label="Target locations" name="targetLocations" value={profile.targetLocations} onChange={set("targetLocations")} placeholder="e.g. Remote, London" />
                  <SelectField
                    label="Work mode"
                    name="workMode"
                    value={profile.workMode ?? ""}
                    onChange={set("workMode")}
                    options={["", "remote", "hybrid", "onsite"]}
                  />
                  <SelectField
                    label="Job-search status"
                    name="jobSearchStatus"
                    value={profile.jobSearchStatus ?? ""}
                    onChange={set("jobSearchStatus")}
                    options={["", "actively looking", "open", "passive"]}
                  />
                </Section>

                {/* Skills & links */}
                <Section title="Skills & links">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="skills">Skills (comma-separated)</Label>
                    <textarea
                      id="skills"
                      name="skills"
                      rows={2}
                      value={profile.skills ?? ""}
                      onChange={set("skills")}
                      placeholder="e.g. TypeScript, React, distributed systems"
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                    />
                  </div>
                  <Field label="LinkedIn URL" name="linkedinUrl" value={profile.linkedinUrl} onChange={set("linkedinUrl")} placeholder="https://linkedin.com/in/you" />
                  <Field label="GitHub URL" name="githubUrl" value={profile.githubUrl} onChange={set("githubUrl")} placeholder="https://github.com/you" />
                  <Field label="Portfolio URL" name="portfolioUrl" value={profile.portfolioUrl} onChange={set("portfolioUrl")} placeholder="https://you.dev" />
                </Section>

                {/* Work auth + CV */}
                <Section title="Work authorization & CV">
                  <Field label="Work authorization" name="workAuth" value={profile.workAuth} onChange={set("workAuth")} placeholder="e.g. EU citizen, needs sponsorship" />
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cv">CV / Résumé (PDF or DOCX)</Label>
                    <input
                      id="cv"
                      type="file"
                      accept=".pdf,.doc,.docx"
                      onChange={e => setCvFile(e.target.files?.[0] ?? null)}
                      className="w-full text-sm text-muted-foreground file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground file:cursor-pointer hover:file:bg-secondary/80"
                    />
                  </div>
                </Section>

                {error && (
                  <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                    {error}
                  </div>
                )}

                <Button type="submit" size="lg" disabled={busy}>
                  {busy ? "Saving…" : "Finish setup"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Errors for steps 1 & 2 */}
        {error && step !== "profile" && (
          <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <p className="text-center text-sm text-muted-foreground mt-6">
          Already have an account?{" "}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

const STEP_ORDER: Record<Step, number> = { account: 0, verify: 1, profile: 2 }
const LABELS: Record<Step, string> = {
  account: "Account",
  verify: "Verify",
  profile: "Profile",
}

// ── Small layout helpers ──────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="text-sm font-semibold text-foreground">{title}</legend>
      {children}
    </fieldset>
  )
}

function Field({
  label,
  name,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
}: {
  label: string
  name: string
  value: string | undefined
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  required?: boolean
  type?: string
  placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  )
}

function SelectField({
  label,
  name,
  value,
  onChange,
  options,
}: {
  label: string
  name: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  options: string[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        value={value}
        onChange={onChange}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map(o => (
          <option key={o} value={o} className="bg-background">
            {o === "" ? "— Select —" : o}
          </option>
        ))}
      </select>
    </div>
  )
}

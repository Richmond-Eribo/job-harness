import { useActionState, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Check, CircleAlert } from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FileInput,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@agent-harness/ui"
import { authClient } from "../lib/auth"
import { api } from "../lib/api"

// Single-page, sectioned signup:
//   1. Account  — email + password → signUpEmail (creates the user, triggers OTP)
//   2. Verify   — 6-digit OTP → verifyEmail (marks email verified + auto-signs-in)
//   3. Profile  — career fields + CV → POST /api/onboarding (flips onboardingComplete)
//   4. Done     → navigate to /dashboard
//
// React 19 form actions: each step's <form action={...}> drives a useActionState.
// `email` persists across steps in React state; the profile step's many fields
// stay controlled in a `profile` object (read on submit, not from FormData, so
// the Select/Textarea helpers keep their controlled value/onValueChange API).
type Step = "account" | "verify" | "profile"

// Sentinel value for the "no selection" item in each Select. Radix Select
// requires non-empty item values, so we map "" (the field's unselected state)
// ↔ "__none__" (the item the user picks to leave it blank).
const NONE = "__none__"

type SignupState = { error?: string }

export function SignupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("account")

  // Account fields — email persists across all steps; password/confirm are
  // step-1-only but kept here for validation.
  const [email, setEmail] = useState("")

  // Profile fields (kept in one object so submit is a single POST).
  const [profile, setProfile] = useState<Record<string, string>>({})
  const [cvFile, setCvFile] = useState<File | null>(null)

  const setText = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setProfile(p => ({ ...p, [k]: e.target.value }))
  const setSelect = (k: string) => (v: string) =>
    setProfile(p => ({ ...p, [k]: v === NONE ? "" : v }))

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
      // sendVerificationOnSignUp + requireEmailVerification: this creates the
      // user (unverified) and emails a 6-digit code. emailVerified stays false
      // until step 2, so sign-in is blocked until the OTP is confirmed.
      const { error: signUpError } = await (authClient as any).signUpEmail({
        email: e,
        password,
        name: e.split("@")[0], // Better Auth requires `name`; derive a default.
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

  // ── Step 2: verify the OTP ─────────────────────────────────────────────
  const [otpState, otpAction, otpPending] = useActionState<SignupState, FormData>(
    async (_prev, fd) => {
      const otp = String(fd.get("otp") ?? "").trim()
      if (otp.length !== 6) {
        return { error: "Enter the 6-digit code from your email." }
      }
      try {
        const { error: verifyError } = await (authClient as any).emailOtp
          .verifyEmail({ email, otp })
        if (verifyError) {
          throw new Error(verifyError.message ?? "Verification failed")
        }
        setStep("profile")
        return {}
      } catch (err: any) {
        return { error: err.message }
      }
    },
    {},
  )

  const resendOtp = async () => {
    if (!email) return
    try {
      const { error: sendError } = await (authClient as any).emailOtp
        .sendVerificationOtp({ email, type: "email-verification" })
      if (sendError) throw new Error(sendError.message ?? "Couldn't resend code")
    } catch {
      // best-effort; user can retry
    }
  }

  // ── Step 3: career profile + CV → finish ───────────────────────────────
  const [profileState, profileAction, profilePending] = useActionState<
    SignupState,
    FormData
  >(async () => {
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
      await api.post("/onboarding", { email, ...profile })
      await navigate({ to: "/dashboard" })
      return {}
    } catch (err: any) {
      return { error: err.message }
    }
  }, {})

  const busy = accountPending || otpPending || profilePending
  const error =
    accountState.error ?? otpState.error ?? profileState.error

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
                  {done ? <Check className="size-3.5" /> : i + 1}
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
                <Button type="submit" disabled={accountPending}>
                  {accountPending ? "Creating…" : "Continue"}
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
              <form action={otpAction} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="su-otp">Verification code</Label>
                  <Input
                    id="su-otp"
                    name="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    placeholder="123456"
                    className="text-lg tracking-[0.5em] text-center"
                  />
                </div>
                <Button type="submit" disabled={otpPending}>
                  {otpPending ? "Verifying…" : "Verify & continue"}
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
              <form action={profileAction} className="flex flex-col gap-6">
                {/* Basics */}
                <Section title="Basics">
                  <Field label="Full name" name="fullName" value={profile.fullName} onChange={setText("fullName")} required />
                  <Field label="Phone (optional)" name="phone" value={profile.phone} onChange={setText("phone")} />
                  <Field label="Location" name="location" value={profile.location} onChange={setText("location")} placeholder="e.g. London, UK" />
                </Section>

                {/* Seniority */}
                <Section title="Experience">
                  <SelectField
                    label="Seniority"
                    name="seniority"
                    value={profile.seniority ?? ""}
                    onChange={setSelect("seniority")}
                    options={["", "Junior", "Mid", "Senior", "Staff", "Principal"]}
                  />
                  <Field label="Years of experience" name="yearsExperience" value={profile.yearsExperience} onChange={setText("yearsExperience")} placeholder="e.g. 7" type="number" />
                </Section>

                {/* Target role */}
                <Section title="What you're looking for">
                  <Field label="Target roles" name="targetRoles" value={profile.targetRoles} onChange={setText("targetRoles")} placeholder="e.g. Senior TypeScript Engineer" />
                  <Field label="Target locations" name="targetLocations" value={profile.targetLocations} onChange={setText("targetLocations")} placeholder="e.g. Remote, London" />
                  <SelectField
                    label="Work mode"
                    name="workMode"
                    value={profile.workMode ?? ""}
                    onChange={setSelect("workMode")}
                    options={["", "remote", "hybrid", "onsite"]}
                  />
                  <SelectField
                    label="Job-search status"
                    name="jobSearchStatus"
                    value={profile.jobSearchStatus ?? ""}
                    onChange={setSelect("jobSearchStatus")}
                    options={["", "actively looking", "open", "passive"]}
                  />
                </Section>

                {/* Skills & links */}
                <Section title="Skills & links">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="skills">Skills (comma-separated)</Label>
                    <Textarea
                      id="skills"
                      name="skills"
                      rows={2}
                      value={profile.skills ?? ""}
                      onChange={e => setProfile(p => ({ ...p, skills: e.target.value }))}
                      placeholder="e.g. TypeScript, React, distributed systems"
                    />
                  </div>
                  <Field label="LinkedIn URL" name="linkedinUrl" value={profile.linkedinUrl} onChange={setText("linkedinUrl")} placeholder="https://linkedin.com/in/you" />
                  <Field label="GitHub URL" name="githubUrl" value={profile.githubUrl} onChange={setText("githubUrl")} placeholder="https://github.com/you" />
                  <Field label="Portfolio URL" name="portfolioUrl" value={profile.portfolioUrl} onChange={setText("portfolioUrl")} placeholder="https://you.dev" />
                </Section>

                {/* Work auth + CV */}
                <Section title="Work authorization & CV">
                  <Field label="Work authorization" name="workAuth" value={profile.workAuth} onChange={setText("workAuth")} placeholder="e.g. EU citizen, needs sponsorship" />
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cv">CV / Résumé (PDF or DOCX)</Label>
                    <FileInput
                      id="cv"
                      type="file"
                      accept=".pdf,.doc,.docx"
                      onChange={e => setCvFile(e.target.files?.[0] ?? null)}
                    />
                  </div>
                </Section>

                {profileState.error && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{profileState.error}</AlertDescription>
                  </Alert>
                )}

                <Button type="submit" size="lg" disabled={profilePending}>
                  {profilePending ? "Saving…" : "Finish setup"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Errors for steps 1 & 2 */}
        {error && step !== "profile" && (
          <Alert variant="destructive" className="mt-4">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
  onChange: (value: string) => void
  options: string[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Select value={value || NONE} onValueChange={onChange}>
        <SelectTrigger id={name} className="w-full">
          <SelectValue placeholder="— Select —" />
        </SelectTrigger>
        <SelectContent>
          {options.map(o => (
            <SelectItem key={o || NONE} value={o || NONE}>
              {o === "" ? "— Select —" : o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

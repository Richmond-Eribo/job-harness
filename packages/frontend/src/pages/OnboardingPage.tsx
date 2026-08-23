import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import {
  CircleAlert,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  FileText,
} from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
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
import { API_URL } from "../lib/auth"
import { api } from "../lib/api"
import { AuthShowcase } from "../components/AuthShowcase"
import { ConnectBrowserCard } from "../components/ConnectBrowserCard"

const NONE = "__none__"
type Step = 0 | 1 | 2
const STEP_META: { label: string; shortLabel: string }[] = [
  { label: "Profile", shortLabel: "Profile" },
  { label: "CV", shortLabel: "CV" },
  { label: "Connect browser", shortLabel: "Browser" },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [p, setP] = useState<Record<string, string>>({})
  const [cvFile, setCvFile] = useState<File | null>(null)
  const [cvUploaded, setCvUploaded] = useState(false)
  const [seedDefaults, setSeedDefaults] = useState(true)

  // Stable closures — only close over setP (stable).
  const setSelect = (k: string) => (v: string) =>
    setP(prev => ({ ...prev, [k]: v === NONE ? "" : v }))
  const setText = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP(prev => ({ ...prev, [k]: e.target.value }))

  // Read form values off uncontrolled inputs at submit time — keeps
  // step transitions cheap (no controlled re-render storm across 6+
  // fields) without losing values when the user moves between steps.
  // Each named input keeps its own DOM state.
  const collectProfile = (form: HTMLFormElement) => {
    const fd = new FormData(form)
    return {
      fullName: String(fd.get("fullName") ?? ""),
      location: String(fd.get("location") ?? "") || p.location,
      seniority: p.seniority,
      workMode: p.workMode,
      targetRoles: String(fd.get("targetRoles") ?? ""),
      skills: String(fd.get("skills") ?? ""),
      jobSearchStatus: p.jobSearchStatus,
      yearsExperience: String(fd.get("yearsExperience") ?? ""),
      targetLocations:
        String(fd.get("targetLocations") ?? "") || p.targetLocations,
      phone: String(fd.get("phone") ?? ""),
      linkedinUrl: String(fd.get("linkedinUrl") ?? ""),
      githubUrl: String(fd.get("githubUrl") ?? ""),
      portfolioUrl: String(fd.get("portfolioUrl") ?? ""),
      workAuth: String(fd.get("workAuth") ?? ""),
    }
  }

  const uploadCv = async () => {
    if (!cvFile) return true
    // C1/P1-1: explicit credentials:"include" so the SameSite=None cookie
    // rides along cross-origin. The shared `api` helper does this too —
    // used fetch() directly here only because we're streaming the raw body.
    const upRes = await fetch(
      `${API_URL}/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": cvFile.type },
        body: cvFile,
      },
    )
    if (!upRes.ok) {
      throw new Error("CV upload failed — please try again.")
    }
    setCvUploaded(true)
    return true
  }

  const finish = async (form: HTMLFormElement) => {
    setSaving(true)
    setError(null)
    try {
      // Upload CV first so /onboarding's seeding + flag-flip happen against
      // a profile that already has the CV pointer — and so the dashboard's
      // pre-flight "cv" check is green from the first load.
      if (cvFile && !cvUploaded) {
        await uploadCv()
      }
      const profile = collectProfile(form)
      await api.post("/onboarding", {
        ...profile,
        seedDefaultJobSources: seedDefaults,
      })
      await navigate({ to: "/dashboard" })
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong. Please try again.")
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground animate-fade-in">
      <AuthShowcase />

      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-12 overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto py-4">
          <div className="mb-6">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 grid place-items-center text-primary mb-4">
              <Sparkles className="size-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              Get started in 3 steps
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Configure your profile, upload your CV, and connect your browser.
            </p>
          </div>

          {/* Progress indicator */}
          <ol className="flex items-center gap-2 mb-6">
            {STEP_META.map((s, i) => {
              const done = i < step
              const active = i === step
              return (
                <li key={s.label} className="flex-1">
                  <div
                    className={`h-1 rounded-full transition-colors ${
                      active
                        ? "bg-primary"
                        : done
                          ? "bg-primary/60"
                          : "bg-border"
                    }`}
                  />
                  <div
                    className={`text-[10px] uppercase tracking-[0.12em] mt-1.5 font-medium ${
                      active || done
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s.shortLabel}
                  </div>
                </li>
              )
            })}
          </ol>

          <form
            id="onboarding-form"
            onSubmit={e => {
              // Invoked from the final step's Finish button (type=submit). On
              // earlier steps Continue uses type=button + setStep(...) so
              // Enter inside a text field doesn't accidentally advance the
              // wizard.
              e.preventDefault()
              void finish(e.currentTarget)
            }}
            className="flex flex-col gap-5"
          >
            {step === 0 && (
              <StepProfile p={p} setSelect={setSelect} setText={setText} />
            )}

            {step === 1 && (
              <StepCv
                cvFile={cvFile}
                onCvChange={f => {
                  setCvFile(f)
                  setCvUploaded(false) // force re-upload if they swap the file
                }}
                seedDefaults={seedDefaults}
                onSeedDefaultsChange={setSeedDefaults}
              />
            )}

            {step === 2 && <StepConnectBrowser />}

            {error && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Step navigation */}
            <div className="flex items-center gap-2 mt-2">
              {step > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep((step - 1) as Step)}
                  disabled={saving}
                >
                  <ChevronLeft className="size-4 mr-1" />
                  Back
                </Button>
              )}
              {step < 2 ? (
                <Button
                  type="button"
                  onClick={() => setStep((step + 1) as Step)}
                  className="flex-1"
                >
                  Continue
                  <ChevronRight className="size-4 ml-1" />
                </Button>
              ) : (
                <Button type="submit" className="flex-1" disabled={saving}>
                  {saving ? "Finishing…" : "Complete setup & launch dashboard"}
                </Button>
              )}
            </div>
          </form>
        </div>

        <div className="w-full max-w-md mx-auto text-center text-xs text-muted-foreground py-4">
          Isolated workspace · Job Agent
        </div>
      </div>
    </div>
  )
}

// ── Step 1 — Profile ──────────────────────────────────────────────────────
// Same fields as the old single-page form, scoped to this step. Required
// fields (fullName) gate the native submit; every other field is optional
// and editable later from Settings → Profile.
function StepProfile({
  p,
  setSelect,
  setText,
}: {
  p: Record<string, string>
  setSelect: (k: string) => (v: string) => void
  setText: (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <SectionLabel>Personal basics</SectionLabel>
      <Field label="Full name" name="fullName" required />
      <Field
        label="Location"
        name="location"
        placeholder="e.g. London, UK"
        value={p.location}
        onChange={setText("location")}
      />
      <Field label="Phone" name="phone" type="tel" placeholder="optional" />

      <SectionLabel>Experience &amp; target roles</SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Seniority"
          name="seniority"
          value={p.seniority ?? ""}
          onChange={setSelect("seniority")}
          options={["", "Junior", "Mid", "Senior", "Staff", "Principal"]}
        />
        <SelectField
          label="Work mode"
          name="workMode"
          value={p.workMode ?? ""}
          onChange={setSelect("workMode")}
          options={["", "remote", "hybrid", "onsite"]}
        />
      </div>
      <Field
        label="Target roles"
        name="targetRoles"
        placeholder="e.g. Senior TypeScript Engineer"
      />
      <Field
        label="Target locations"
        name="targetLocations"
        placeholder="e.g. London, Remote EU"
        value={p.targetLocations}
        onChange={setText("targetLocations")}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skills" className="text-xs text-muted-foreground">
          Skills (comma-separated)
        </Label>
        <Textarea
          id="skills"
          name="skills"
          rows={2}
          placeholder="e.g. TypeScript, React, Cloudflare Workers"
        />
      </div>
    </div>
  )
}

// ── Step 2 — CV ────────────────────────────────────────────────────────────
// CV upload + the "seed default job sources" opt-in. Both reduce the chance
// of a guaranteed-empty first dashboard (no CV = no cover letters, no sources
// = agent can't browse). CV is optional here — the wizard still lets the
// user finish and fix it later from Settings (the pre-flight checklist
// reminds them).
function StepCv({
  cvFile,
  onCvChange,
  seedDefaults,
  onSeedDefaultsChange,
}: {
  cvFile: File | null
  onCvChange: (f: File | null) => void
  seedDefaults: boolean
  onSeedDefaultsChange: (v: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <SectionLabel>Upload your CV</SectionLabel>
      <p className="text-xs text-muted-foreground -mt-3">
        The agent tailors cover letters and ranks roles against this. PDF or
        DOCX, up to 10 MB. You can skip this and upload later from Settings.
      </p>
      <FileInput
        id="cv"
        accept=".pdf,.doc,.docx"
        onChange={e => onCvChange(e.target.files?.[0] ?? null)}
      />
      {cvFile && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-4 text-primary" />
          <span className="truncate">
            {cvFile.name} ({Math.round(cvFile.size / 1024)} KB)
          </span>
        </div>
      )}

      <SectionLabel>Job sources</SectionLabel>
      <label className="flex items-start gap-3 cursor-pointer text-sm">
        <input
          type="checkbox"
          checked={seedDefaults}
          onChange={e => onSeedDefaultsChange(e.target.checked)}
          className="mt-0.5 size-4 accent-primary cursor-pointer"
        />
        <span>
          <span className="text-foreground font-medium">
            Seed starter job sources
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Adds a couple of public, login-free boards so the agent has
            something to search right away. Edit or remove them anytime from
            Jobs → Sources.
          </span>
        </span>
      </label>
    </div>
  )
}

// ── Step 3 — Connect browser ───────────────────────────────────────────────
// Delegates to the shared ConnectBrowserCard funnel (also used by Settings →
// Browser & Extension): explicit install instructions, live extension
// detection, the pairing code with auto-mint, and a green flip the moment the
// extension connects (GET /api/browser/status is polled). Skipping is allowed
// (the extension can be paired any time from Settings).
function StepConnectBrowser() {
  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <SectionLabel>Pair your browser</SectionLabel>
      <ConnectBrowserCard autoGenerateCode />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm font-semibold text-foreground border-l-2 border-primary pl-2.5">
      {children}
    </div>
  )
}

function Field({
  label,
  name,
  required,
  type = "text",
  placeholder,
  value,
  onChange,
}: {
  label: string
  name: string
  required?: boolean
  type?: string
  placeholder?: string
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
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
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name} className="text-xs text-muted-foreground">
        {label}
      </Label>
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

import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
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
import { api } from "../lib/api"

// Onboarding for an existing user who hasn't completed their profile yet.
// (New users go through the full signup at /signup; this is the re-entry point
// the onboarding gate sends them to.) Field set mirrors SignupPage's profile
// section so both paths capture the same career data.
export function OnboardingPage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cvFile, setCvFile] = useState<File | null>(null)
  const [p, setP] = useState<Record<string, string>>({})

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setP(prev => ({ ...prev, [k]: e.target.value }))

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const form = e.currentTarget
      const fd = new FormData(form)

      // 1. Upload CV to R2 if selected.
      if (cvFile) {
        const upRes = await fetch(
          `/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
          { method: "POST", headers: { "Content-Type": cvFile.type }, body: cvFile },
        )
        if (!upRes.ok) throw new Error("CV upload failed")
      }

      // 2. Save profile + mark onboarding complete. Merge form data with the
      //    select-driven fields tracked in React state.
      await api.post("/onboarding", {
        fullName: fd.get("fullName"),
        phone: fd.get("phone"),
        location: fd.get("location") ?? p.location,
        seniority: p.seniority,
        yearsExperience: p.yearsExperience,
        targetRoles: fd.get("targetRoles"),
        targetLocations: fd.get("targetLocations") ?? p.targetLocations,
        workMode: p.workMode,
        jobSearchStatus: p.jobSearchStatus,
        skills: fd.get("skills"),
        linkedinUrl: fd.get("linkedinUrl"),
        githubUrl: fd.get("githubUrl"),
        portfolioUrl: fd.get("portfolioUrl"),
        workAuth: fd.get("workAuth"),
      })
      navigate({ to: "/dashboard" })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Complete your profile</CardTitle>
            <CardDescription>
              This powers your job-search agent. The richer the profile, the
              better the targeting. Editable later in Settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-6">
              <Section title="Basics">
                <Field label="Full name" name="fullName" required />
                <Field label="Phone (optional)" name="phone" />
                <Field label="Location" name="location" placeholder="e.g. London, UK" />
              </Section>

              <Section title="Experience">
                <SelectField label="Seniority" name="seniority" value={p.seniority ?? ""} onChange={set("seniority")} options={["", "Junior", "Mid", "Senior", "Staff", "Principal"]} />
                <Field label="Years of experience" name="yearsExperience" type="number" value={p.yearsExperience} onChange={set("yearsExperience")} placeholder="e.g. 7" />
              </Section>

              <Section title="What you're looking for">
                <Field label="Target roles" name="targetRoles" placeholder="e.g. Senior TypeScript Engineer" />
                <Field label="Target locations" name="targetLocations" placeholder="e.g. Remote, London" />
                <SelectField label="Work mode" name="workMode" value={p.workMode ?? ""} onChange={set("workMode")} options={["", "remote", "hybrid", "onsite"]} />
                <SelectField label="Job-search status" name="jobSearchStatus" value={p.jobSearchStatus ?? ""} onChange={set("jobSearchStatus")} options={["", "actively looking", "open", "passive"]} />
              </Section>

              <Section title="Skills & links">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="skills">Skills (comma-separated)</Label>
                  <textarea
                    id="skills"
                    name="skills"
                    rows={2}
                    placeholder="e.g. TypeScript, React, distributed systems"
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring resize-y"
                  />
                </div>
                <Field label="LinkedIn URL" name="linkedinUrl" placeholder="https://linkedin.com/in/you" />
                <Field label="GitHub URL" name="githubUrl" placeholder="https://github.com/you" />
                <Field label="Portfolio URL" name="portfolioUrl" placeholder="https://you.dev" />
              </Section>

              <Section title="Work authorization & CV">
                <Field label="Work authorization" name="workAuth" placeholder="e.g. EU citizen, needs sponsorship" />
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
                <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
              )}

              <Button type="submit" size="lg" disabled={busy}>
                {busy ? "Saving…" : "Complete setup"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

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
  // When `value`/`onChange` are provided, treat as controlled (for fields that
  // need React state, e.g. number/select-driven). Otherwise uncontrolled
  // (reads from FormData on submit, like the original onboarding form).
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
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
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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

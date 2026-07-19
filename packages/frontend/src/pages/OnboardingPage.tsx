import { useActionState, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
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
import { api } from "../lib/api"

// Onboarding for an existing user who hasn't completed their profile yet.
// (New users go through the full signup at /signup; this is the re-entry point
// the onboarding gate sends them to.) Field set mirrors SignupPage's profile
// section so both paths capture the same career data.
//
// React 19 form action: the <form action={...}> drives a useActionState. Text
// fields are uncontrolled (read from FormData in the action); the Select-driven
// + number fields stay controlled in `p` state and are merged in the action.
//
// Sentinel value for the "no selection" item in each Select. Radix Select
// requires non-empty item values, so we map "" (the field's unselected state)
// ↔ "__none__" (the item the user picks to leave it blank).
const NONE = "__none__"

type OnboardingState = { error?: string }

export function OnboardingPage() {
  const navigate = useNavigate()
  const [cvFile, setCvFile] = useState<File | null>(null)
  const [p, setP] = useState<Record<string, string>>({})

  const setSelect = (k: string) => (v: string) =>
    setP(prev => ({ ...prev, [k]: v === NONE ? "" : v }))
  const setText = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP(prev => ({ ...prev, [k]: e.target.value }))

  const [state, action, pending] = useActionState<OnboardingState, FormData>(
    async (_prev, fd) => {
      try {
        // 1. Upload CV to R2 if selected.
        if (cvFile) {
          const upRes = await fetch(
            `/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
            {
              method: "POST",
              headers: { "Content-Type": cvFile.type },
              body: cvFile,
            },
          )
          if (!upRes.ok) throw new Error("CV upload failed")
        }

        // 2. Save profile + mark onboarding complete. Merge FormData (text
        //    fields) with the select/number-driven fields tracked in state.
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
        await navigate({ to: "/dashboard" })
        return {}
      } catch (err: any) {
        return { error: err.message }
      }
    },
    {},
  )

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
            <form action={action} className="flex flex-col gap-6">
              <Section title="Basics">
                <Field label="Full name" name="fullName" required />
                <Field label="Phone (optional)" name="phone" />
                <Field
                  label="Location"
                  name="location"
                  placeholder="e.g. London, UK"
                  value={p.location}
                  onChange={setText("location")}
                />
              </Section>

              <Section title="Experience">
                <SelectField
                  label="Seniority"
                  name="seniority"
                  value={p.seniority ?? ""}
                  onChange={setSelect("seniority")}
                  options={["", "Junior", "Mid", "Senior", "Staff", "Principal"]}
                />
                <Field
                  label="Years of experience"
                  name="yearsExperience"
                  type="number"
                  value={p.yearsExperience}
                  onChange={setText("yearsExperience")}
                  placeholder="e.g. 7"
                />
              </Section>

              <Section title="What you're looking for">
                <Field
                  label="Target roles"
                  name="targetRoles"
                  placeholder="e.g. Senior TypeScript Engineer"
                />
                <Field
                  label="Target locations"
                  name="targetLocations"
                  placeholder="e.g. Remote, London"
                  value={p.targetLocations}
                  onChange={setText("targetLocations")}
                />
                <SelectField
                  label="Work mode"
                  name="workMode"
                  value={p.workMode ?? ""}
                  onChange={setSelect("workMode")}
                  options={["", "remote", "hybrid", "onsite"]}
                />
                <SelectField
                  label="Job-search status"
                  name="jobSearchStatus"
                  value={p.jobSearchStatus ?? ""}
                  onChange={setSelect("jobSearchStatus")}
                  options={["", "actively looking", "open", "passive"]}
                />
              </Section>

              <Section title="Skills & links">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="skills">Skills (comma-separated)</Label>
                  <Textarea
                    id="skills"
                    name="skills"
                    rows={2}
                    placeholder="e.g. TypeScript, React, distributed systems"
                  />
                </div>
                <Field
                  label="LinkedIn URL"
                  name="linkedinUrl"
                  placeholder="https://linkedin.com/in/you"
                />
                <Field
                  label="GitHub URL"
                  name="githubUrl"
                  placeholder="https://github.com/you"
                />
                <Field
                  label="Portfolio URL"
                  name="portfolioUrl"
                  placeholder="https://you.dev"
                />
              </Section>

              <Section title="Work authorization & CV">
                <Field
                  label="Work authorization"
                  name="workAuth"
                  placeholder="e.g. EU citizen, needs sponsorship"
                />
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cv">CV / Résumé (PDF or DOCX)</Label>
                  <FileInput
                    id="cv"
                    accept=".pdf,.doc,.docx"
                    onChange={e => setCvFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </Section>

              {state.error && (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" size="lg" disabled={pending}>
                {pending ? "Saving…" : "Complete setup"}
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

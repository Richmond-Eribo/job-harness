import { useActionState, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { CircleAlert, Sparkles } from "lucide-react"
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
        if (cvFile) {
          // C1/P1-1: the api helper sets credentials:"include" so the
          // SameSite=None session cookie rides along cross-origin. A bare
          // fetch does NOT — without this, requireAuth returns 401 and the
          // upload silently fails for every user.
          const upRes = await fetch(
            `${API_URL}/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": cvFile.type },
              body: cvFile,
            },
          )
          if (!upRes.ok) throw new Error("CV upload failed")
        }

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
    <div className="flex min-h-screen bg-background text-foreground animate-fade-in">
      {/* Left 50% Showcase Panel */}
      <AuthShowcase />

      {/* Right 50% Form Area */}
      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-12 overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto py-4">
          <div className="mb-6">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 grid place-items-center text-primary mb-4">
              <Sparkles className="size-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Complete your profile</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Configure your preferences so the agent targets the right job listings.
            </p>
          </div>

          <form action={action} className="flex flex-col gap-5">
            <div className="text-sm font-semibold text-foreground border-l-2 border-primary pl-2.5">
              Personal Basics
            </div>
            <Field label="Full name" name="fullName" required />
            <Field
              label="Location"
              name="location"
              placeholder="e.g. London, UK"
              value={p.location}
              onChange={setText("location")}
            />

            <div className="text-sm font-semibold text-foreground border-l-2 border-primary pl-2.5">
              Experience & Target Roles
            </div>
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

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skills" className="text-xs text-muted-foreground">Skills (comma-separated)</Label>
              <Textarea
                id="skills"
                name="skills"
                rows={2}
                placeholder="e.g. TypeScript, React, Cloudflare Workers"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cv" className="text-xs text-muted-foreground">CV / Résumé (PDF or DOCX)</Label>
              <FileInput
                id="cv"
                accept=".pdf,.doc,.docx"
                onChange={e => setCvFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {state.error && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" size="lg" disabled={pending} className="w-full mt-2">
              {pending ? "Saving profile…" : "Complete Setup & Launch Dashboard"}
            </Button>
          </form>
        </div>

        <div className="w-full max-w-md mx-auto text-center text-xs text-muted-foreground py-4">
          Isolated workspace · Job Agent
        </div>
      </div>
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
      <Label htmlFor={name} className="text-xs text-muted-foreground">{label}</Label>
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
      <Label htmlFor={name} className="text-xs text-muted-foreground">{label}</Label>
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

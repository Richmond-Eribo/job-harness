import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { useProfile } from "../hooks/queries"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
} from "@agent-harness/ui"
import { toast } from "sonner"

// The full profile field set (mirrors Signup/Onboarding) so PUT /api/profile
// round-trips everything the user entered at signup.
const TEXT_FIELDS: { name: string; label: string; type?: string; placeholder?: string }[] = [
  { name: "fullName", label: "Full name" },
  { name: "email", label: "Email", type: "email" },
  { name: "phone", label: "Phone" },
  { name: "location", label: "Location", placeholder: "e.g. London, UK" },
  { name: "yearsExperience", label: "Years of experience", type: "number", placeholder: "e.g. 7" },
  { name: "targetRoles", label: "Target roles", placeholder: "e.g. Senior TypeScript Engineer" },
  { name: "targetLocations", label: "Target locations", placeholder: "e.g. Remote, London" },
  { name: "linkedinUrl", label: "LinkedIn URL", placeholder: "https://linkedin.com/in/you" },
  { name: "githubUrl", label: "GitHub URL", placeholder: "https://github.com/you" },
  { name: "portfolioUrl", label: "Portfolio URL", placeholder: "https://you.dev" },
  { name: "workAuth", label: "Work authorization", placeholder: "e.g. EU citizen, needs sponsorship" },
]

const SELECT_FIELDS: { name: string; label: string; options: string[] }[] = [
  { name: "seniority", label: "Seniority", options: ["", "Junior", "Mid", "Senior", "Staff", "Principal"] },
  { name: "workMode", label: "Work mode", options: ["", "remote", "hybrid", "onsite"] },
  { name: "jobSearchStatus", label: "Job-search status", options: ["", "actively looking", "open", "passive"] },
]

export function SettingsPage() {
  const qc = useQueryClient()
  const { data: profile, isLoading } = useProfile()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [skills, setSkills] = useState("")

  useEffect(() => {
    if (profile) {
      const f: Record<string, string> = {}
      for (const k of [...TEXT_FIELDS.map(t => t.name), ...SELECT_FIELDS.map(s => s.name)]) {
        if (profile[k as keyof typeof profile] != null) {
          f[k] = String(profile[k as keyof typeof profile])
        }
      }
      setForm(f)
      setSkills(String(profile.skills ?? ""))
    }
  }, [profile])

  const save = async () => {
    setSaving(true)
    try {
      await api.put("/profile", { ...form, skills })
      qc.invalidateQueries({ queryKey: ["profile"] })
      toast.success("Profile saved")
    } catch (e: any) {
      toast.error("Couldn't save profile", { description: e?.message })
    } finally {
      setSaving(false)
    }
  }

  const [cvFile, setCvFile] = useState<File | null>(null)
  const [cvUploading, setCvUploading] = useState(false)

  const uploadCv = async () => {
    if (!cvFile) return
    setCvUploading(true)
    try {
      const res = await fetch(
        `/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
        { method: "POST", headers: { "Content-Type": cvFile.type }, body: cvFile },
      )
      if (!res.ok) throw new Error("Upload failed")
      const data = await res.json()
      qc.invalidateQueries({ queryKey: ["profile"] })
      toast.success(`Uploaded ${data.filename}`)
      setCvFile(null)
    } catch (e: any) {
      toast.error("CV upload failed", { description: e?.message })
    } finally {
      setCvUploading(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          {/* Profile */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Profile</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {TEXT_FIELDS.map(f => (
                <div key={f.name} className="flex flex-col gap-2">
                  <Label htmlFor={f.name}>{f.label}</Label>
                  <Input
                    id={f.name}
                    type={f.type ?? "text"}
                    placeholder={f.placeholder}
                    value={form[f.name] ?? ""}
                    onChange={e => setForm({ ...form, [f.name]: e.target.value })}
                  />
                </div>
              ))}

              {SELECT_FIELDS.map(f => (
                <div key={f.name} className="flex flex-col gap-2">
                  <Label htmlFor={f.name}>{f.label}</Label>
                  <select
                    id={f.name}
                    value={form[f.name] ?? ""}
                    onChange={e => setForm({ ...form, [f.name]: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {f.options.map(o => (
                      <option key={o} value={o} className="bg-background">
                        {o === "" ? "— Select —" : o}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <div className="flex flex-col gap-2">
                <Label htmlFor="skills">Skills (comma-separated)</Label>
                <textarea
                  id="skills"
                  rows={2}
                  value={skills}
                  onChange={e => setSkills(e.target.value)}
                  placeholder="e.g. TypeScript, React, distributed systems"
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring resize-y"
                />
              </div>

              <Button onClick={save} disabled={saving} className="self-start">
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </CardContent>
          </Card>

          {/* CV */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">CV / Résumé</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {profile?.cvFilename && (
                <div className="text-sm text-muted-foreground">
                  Current: {profile.cvFilename}{" "}
                  {profile.cvUploadedAt && `(${new Date(profile.cvUploadedAt).toLocaleDateString()})`}{" "}
                  <a href="/api/profile/cv" className="text-primary hover:underline">Download</a>
                </div>
              )}
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  onChange={e => setCvFile(e.target.files?.[0] ?? null)}
                  className="text-sm text-muted-foreground file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground file:cursor-pointer hover:file:bg-secondary/80"
                />
                <Button variant="secondary" onClick={uploadCv} disabled={!cvFile || cvUploading} size="sm">
                  {cvUploading ? "Uploading…" : "Upload"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

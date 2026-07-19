import { useState, useEffect } from "react"
import { Download, FileText, User, Briefcase, Link2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { API_URL } from "../lib/auth"
import { useProfile } from "../hooks/queries"
import {
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
  Skeleton,
  Textarea,
} from "@agent-harness/ui"
import { toast } from "sonner"

const NONE = "__none__"

export function ProfilePage() {
  const qc = useQueryClient()
  const { data: profile, isLoading } = useProfile()

  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [skills, setSkills] = useState("")

  useEffect(() => {
    if (profile) {
      const f: Record<string, string> = {}
      const keys = [
        "firstName",
        "lastName",
        "email",
        "phone",
        "location",
        "yearsExperience",
        "targetRoles",
        "targetLocations",
        "linkedinUrl",
        "githubUrl",
        "portfolioUrl",
        "workAuth",
        "seniority",
        "workMode",
        "jobSearchStatus",
      ]
      for (const k of keys) {
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
      // C1/P1-1: same-as-OnboardingPage — explicit credentials:"include" so
      // the cross-origin session cookie is attached. (Also using the
      // absolute API_URL rather than a relative path so this works in both
      // same-origin legacy mode and the standalone-frontend mode.)
      const res = await fetch(
        `${API_URL}/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": cvFile.type },
          body: cvFile,
        },
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
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Your Profile
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure candidate preferences, career targeting parameters, and CV
            files.
          </p>
        </div>
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? "Saving Changes…" : "Save All Settings"}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Left Sub-Nav */}
          <div className="lg:col-span-1 space-y-1">
            <a
              href="#personal"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary"
            >
              <User className="size-4" /> Personal Details
            </a>
            <a
              href="#preferences"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              <Briefcase className="size-4" /> Preferences & Targets
            </a>
            <a
              href="#links"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              <Link2 className="size-4" /> Links & Authorization
            </a>
            <a
              href="#cv"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              <FileText className="size-4" /> CV & Résumé
            </a>
          </div>

          {/* Right Content */}
          <div className="lg:col-span-3 space-y-6">
            {/* Personal Details */}
            <Card id="personal">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <User className="size-4 text-primary" />
                  Personal Information
                </CardTitle>
                <CardDescription className="text-xs">
                  Basic profile information for applications.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* First + last name — the fields the gate requires */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="firstName"
                      className="text-xs text-muted-foreground"
                    >
                      First name
                    </Label>
                    <Input
                      id="firstName"
                      value={form.firstName ?? ""}
                      onChange={e =>
                        setForm({ ...form, firstName: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="lastName"
                      className="text-xs text-muted-foreground"
                    >
                      Last name
                    </Label>
                    <Input
                      id="lastName"
                      value={form.lastName ?? ""}
                      onChange={e =>
                        setForm({ ...form, lastName: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="email"
                      className="text-xs text-muted-foreground"
                    >
                      Email Address
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email ?? ""}
                      onChange={e =>
                        setForm({ ...form, email: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="phone"
                      className="text-xs text-muted-foreground"
                    >
                      Phone Number
                    </Label>
                    <Input
                      id="phone"
                      value={form.phone ?? ""}
                      onChange={e =>
                        setForm({ ...form, phone: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="location"
                    className="text-xs text-muted-foreground"
                  >
                    Current Location
                  </Label>
                  <Input
                    id="location"
                    placeholder="e.g. London, UK"
                    value={form.location ?? ""}
                    onChange={e =>
                      setForm({ ...form, location: e.target.value })
                    }
                    className="text-xs"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Career Targeting & Preferences */}
            <Card id="preferences">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Briefcase className="size-4 text-primary" />
                  Career Preferences & Targeting
                </CardTitle>
                <CardDescription className="text-xs">
                  Configure how the agent evaluates and scores job matches.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="seniority"
                      className="text-xs text-muted-foreground"
                    >
                      Seniority Level
                    </Label>
                    <Select
                      value={form.seniority || NONE}
                      onValueChange={v =>
                        setForm({ ...form, seniority: v === NONE ? "" : v })
                      }
                    >
                      <SelectTrigger id="seniority" className="w-full text-xs">
                        <SelectValue placeholder="— Select —" />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          "",
                          "Junior",
                          "Mid",
                          "Senior",
                          "Staff",
                          "Principal",
                        ].map(o => (
                          <SelectItem key={o || NONE} value={o || NONE}>
                            {o === "" ? "— Select —" : o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label
                      htmlFor="workMode"
                      className="text-xs text-muted-foreground"
                    >
                      Work Mode
                    </Label>
                    <Select
                      value={form.workMode || NONE}
                      onValueChange={v =>
                        setForm({ ...form, workMode: v === NONE ? "" : v })
                      }
                    >
                      <SelectTrigger id="workMode" className="w-full text-xs">
                        <SelectValue placeholder="— Select —" />
                      </SelectTrigger>
                      <SelectContent>
                        {["", "remote", "hybrid", "onsite"].map(o => (
                          <SelectItem key={o || NONE} value={o || NONE}>
                            {o === "" ? "— Select —" : o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label
                      htmlFor="yearsExperience"
                      className="text-xs text-muted-foreground"
                    >
                      Years Experience
                    </Label>
                    <Input
                      id="yearsExperience"
                      type="number"
                      placeholder="e.g. 7"
                      value={form.yearsExperience ?? ""}
                      onChange={e =>
                        setForm({ ...form, yearsExperience: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="targetRoles"
                      className="text-xs text-muted-foreground"
                    >
                      Target Role Titles
                    </Label>
                    <Input
                      id="targetRoles"
                      placeholder="e.g. Senior TypeScript Engineer"
                      value={form.targetRoles ?? ""}
                      onChange={e =>
                        setForm({ ...form, targetRoles: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="targetLocations"
                      className="text-xs text-muted-foreground"
                    >
                      Target Locations
                    </Label>
                    <Input
                      id="targetLocations"
                      placeholder="e.g. Remote, London"
                      value={form.targetLocations ?? ""}
                      onChange={e =>
                        setForm({ ...form, targetLocations: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="skills"
                    className="text-xs text-muted-foreground"
                  >
                    Skills (comma-separated)
                  </Label>
                  <Textarea
                    id="skills"
                    rows={3}
                    value={skills}
                    onChange={e => setSkills(e.target.value)}
                    placeholder="e.g. TypeScript, React, Cloudflare Workers"
                    className="text-xs"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Links & Authorization */}
            <Card id="links">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Link2 className="size-4 text-primary" />
                  Links & Work Authorization
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="linkedinUrl"
                      className="text-xs text-muted-foreground"
                    >
                      LinkedIn URL
                    </Label>
                    <Input
                      id="linkedinUrl"
                      placeholder="https://linkedin.com/in/you"
                      value={form.linkedinUrl ?? ""}
                      onChange={e =>
                        setForm({ ...form, linkedinUrl: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="githubUrl"
                      className="text-xs text-muted-foreground"
                    >
                      GitHub URL
                    </Label>
                    <Input
                      id="githubUrl"
                      placeholder="https://github.com/you"
                      value={form.githubUrl ?? ""}
                      onChange={e =>
                        setForm({ ...form, githubUrl: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="portfolioUrl"
                      className="text-xs text-muted-foreground"
                    >
                      Portfolio URL
                    </Label>
                    <Input
                      id="portfolioUrl"
                      placeholder="https://you.dev"
                      value={form.portfolioUrl ?? ""}
                      onChange={e =>
                        setForm({ ...form, portfolioUrl: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="workAuth"
                      className="text-xs text-muted-foreground"
                    >
                      Work Authorization
                    </Label>
                    <Input
                      id="workAuth"
                      placeholder="e.g. EU citizen, needs sponsorship"
                      value={form.workAuth ?? ""}
                      onChange={e =>
                        setForm({ ...form, workAuth: e.target.value })
                      }
                      className="text-xs"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* CV & Résumé */}
            <Card id="cv">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="size-4 text-primary" />
                  CV / Résumé Document
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {profile?.cvFilename && (
                  <div className="flex items-center justify-between p-3.5 bg-secondary/40 rounded-lg border border-border">
                    <div className="flex items-center gap-3">
                      <FileText className="size-5 text-primary shrink-0" />
                      <div>
                        <div className="text-xs font-semibold text-foreground">
                          {profile.cvFilename}
                        </div>
                        {profile.cvUploadedAt && (
                          <div className="text-[11px] text-muted-foreground font-mono">
                            Uploaded{" "}
                            {new Date(
                              profile.cvUploadedAt,
                            ).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    </div>

                    <Button asChild variant="outline" size="sm" className="h-8">
                      <a href="/api/profile/cv">
                        <Download className="size-3.5 mr-1.5" /> Download
                      </a>
                    </Button>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <FileInput
                    accept=".pdf,.doc,.docx"
                    onChange={e => setCvFile(e.target.files?.[0] ?? null)}
                    className="max-w-xs text-xs"
                  />
                  <Button
                    variant="secondary"
                    onClick={uploadCv}
                    disabled={!cvFile || cvUploading}
                    size="sm"
                  >
                    {cvUploading ? "Uploading…" : "Upload CV"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

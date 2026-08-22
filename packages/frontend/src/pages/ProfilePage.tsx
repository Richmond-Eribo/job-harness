import { useState } from "react"
import {
  Download,
  FileText,
  User,
  Briefcase,
  Link2,
  CircleAlert,
} from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
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

// The 15 editable profile keys the original save() sent. Keeping this as an
// explicit allowlist prevents leaking read-only server fields (cvFilename,
// cvUploadedAt, createdAt, updatedAt) back to the API in the PUT payload.
const EDITABLE_KEYS = [
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
] as const

export function ProfilePage() {
  const qc = useQueryClient()
  const { data: profile, isLoading, isError, error, refetch } = useProfile()

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Edits overlay (derived-values pattern — no useEffect sync).     │
  // │ The query cache is the source of truth; local state tracks      │
  // │ only user-introduced overrides. Resolved value:                 │
  // │   v(k) = edits[k] ?? String(profile?.[k] ?? "")                  │
  // │ Profile refetches are harmless because the overlay wins.       │
  // └─────────────────────────────────────────────────────────────────┘
  const [edits, setEdits] = useState<Record<string, string>>({})
  const v = (k: string): string =>
    edits[k] ?? String(profile?.[k as keyof typeof profile] ?? "")
  const set = (k: string, value: string) =>
    setEdits(prev => ({ ...prev, [k]: value }))

  const save = useMutation({
    mutationFn: async () => {
      // Build payload from the SAME v() helper used in render — no
      // duplication, no leakage of read-only fields.
      const payload: Record<string, string> = {}
      for (const k of EDITABLE_KEYS) payload[k] = v(k)
      payload.skills = v("skills")
      await api.put("/profile", payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] })
      setEdits({}) // overlay no longer needed — server has latest
      toast.success("Profile saved")
    },
    onError: (e: { message?: string }) =>
      toast.error("Couldn't save profile", { description: e?.message }),
  })

  const [cvFile, setCvFile] = useState<File | null>(null)

  const uploadCv = useMutation({
    mutationFn: async () => {
      if (!cvFile) return
      // C1/P1-1: same-as-OnboardingPage — explicit credentials:"include" so
      // the cross-origin session cookie is attached. Also using the
      // absolute API_URL rather than a relative path so this works in both
      // same-origin legacy mode and the standalone-frontend mode.
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
      return res.json() as Promise<{ filename: string }>
    },
    onSuccess: data => {
      qc.invalidateQueries({ queryKey: ["profile"] })
      toast.success(`Uploaded ${data?.filename ?? cvFile?.name ?? ""}`)
      setCvFile(null)
    },
    onError: (e: { message?: string }) =>
      toast.error("CV upload failed", { description: e?.message }),
  })

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
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          size="sm"
        >
          {save.isPending ? "Saving Changes…" : "Save All Settings"}
        </Button>
      </div>

      {isError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-8 text-center">
            <CircleAlert className="size-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm font-medium">Failed to load profile</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as { message?: string })?.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
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
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Briefcase className="size-4" /> Preferences & Targets
            </a>
            <a
              href="#links"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Link2 className="size-4" /> Links & Authorization
            </a>
            <a
              href="#cv"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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
                      value={v("firstName")}
                      onChange={e => set("firstName", e.target.value)}
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
                      value={v("lastName")}
                      onChange={e => set("lastName", e.target.value)}
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
                      value={v("email")}
                      onChange={e => set("email", e.target.value)}
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
                      value={v("phone")}
                      onChange={e => set("phone", e.target.value)}
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
                    value={v("location")}
                    onChange={e => set("location", e.target.value)}
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
                      value={v("seniority") || NONE}
                      onValueChange={val =>
                        set("seniority", val === NONE ? "" : val)
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
                      value={v("workMode") || NONE}
                      onValueChange={val =>
                        set("workMode", val === NONE ? "" : val)
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
                      value={v("yearsExperience")}
                      onChange={e => set("yearsExperience", e.target.value)}
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
                      value={v("targetRoles")}
                      onChange={e => set("targetRoles", e.target.value)}
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
                      value={v("targetLocations")}
                      onChange={e => set("targetLocations", e.target.value)}
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
                    value={v("skills")}
                    onChange={e => set("skills", e.target.value)}
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
                      value={v("linkedinUrl")}
                      onChange={e => set("linkedinUrl", e.target.value)}
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
                      value={v("githubUrl")}
                      onChange={e => set("githubUrl", e.target.value)}
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
                      value={v("portfolioUrl")}
                      onChange={e => set("portfolioUrl", e.target.value)}
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
                      value={v("workAuth")}
                      onChange={e => set("workAuth", e.target.value)}
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
                  <div className="flex items-center justify-between p-3.5 bg-muted/50 rounded-lg border border-border">
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
                    onClick={() => uploadCv.mutate()}
                    disabled={!cvFile || uploadCv.isPending}
                    size="sm"
                  >
                    {uploadCv.isPending ? "Uploading…" : "Upload CV"}
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

import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { api } from "../lib/api"

// The onboarding form collects the minimum profile needed for the agent to
// work: name, email, target roles/locations, skills, work auth, and a CV
// upload. On submit it POSTs the profile to /api/onboarding (which writes the
// profile + marks onboarding_complete=1), then navigates home.
export function OnboardingPage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cvFile, setCvFile] = useState<File | null>(null)

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

      // 2. Save profile + mark onboarding complete.
      await api.post("/onboarding", {
        fullName: fd.get("fullName"),
        email: fd.get("email"),
        phone: fd.get("phone"),
        location: fd.get("location"),
        targetRoles: fd.get("targetRoles"),
        targetLocations: fd.get("targetLocations"),
        skills: fd.get("skills"),
        workAuth: fd.get("workAuth"),
      })
      navigate({ to: "/" })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const field = (name: string, label: string, opts?: { type?: string; required?: boolean; placeholder?: string }) => (
    <div className="mb-4">
      <label className="block text-sm text-ink-300 mb-1.5">{label}</label>
      <input
        name={name}
        type={opts?.type ?? "text"}
        required={opts?.required}
        placeholder={opts?.placeholder}
        className="w-full px-3 py-2 rounded-lg bg-ink-950 border border-ink-800 text-white focus:outline-none focus:border-accent"
      />
    </div>
  )

  return (
    <div className="min-h-screen bg-ink-950 py-10 px-4">
      <form onSubmit={submit} className="max-w-xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Complete your profile</h1>
        <p className="text-sm text-ink-500 mb-6">
          This powers your job search agent. Editable later in Settings.
        </p>

        {field("fullName", "Full name", { required: true })}
        {field("email", "Email", { type: "email", required: true })}
        {field("phone", "Phone")}
        {field("location", "Location", { placeholder: "e.g. London, UK" })}
        {field("targetRoles", "Target roles", { placeholder: "e.g. Senior TypeScript Engineer" })}
        {field("targetLocations", "Target locations", { placeholder: "e.g. Remote, London" })}

        <div className="mb-4">
          <label className="block text-sm text-ink-300 mb-1.5">Skills (comma-separated)</label>
          <textarea
            name="skills"
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-ink-950 border border-ink-800 text-white focus:outline-none focus:border-accent resize-vertical"
          />
        </div>

        {field("workAuth", "Work authorization", { placeholder: "e.g. EU citizen, needs sponsorship" })}

        <div className="mb-6">
          <label className="block text-sm text-ink-300 mb-1.5">CV / Résumé (PDF or DOCX)</label>
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={e => setCvFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-ink-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink-800 file:text-white file:cursor-pointer hover:file:bg-ink-700"
          />
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-950 text-red-300 text-sm">{error}</div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="px-6 py-2.5 rounded-lg bg-accent text-white font-semibold hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {busy ? "Saving…" : "Complete setup"}
        </button>
      </form>
    </div>
  )
}

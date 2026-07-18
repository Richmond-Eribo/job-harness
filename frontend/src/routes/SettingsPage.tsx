import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"

export function SettingsPage() {
  const qc = useQueryClient()
  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.get("/profile"),
  })
  const [form, setForm] = useState<Record<string, string>>({})

  useEffect(() => {
    if (profile) {
      const f: Record<string, string> = {}
      for (const k of [
        "fullName", "email", "phone", "location", "targetRoles",
        "targetLocations", "skills", "workAuth", "preferences",
      ]) {
        if (profile[k] != null) f[k] = String(profile[k])
      }
      setForm(f)
    }
  }, [profile])

  const save = useMutation({
    mutationFn: () => api.put("/profile", form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  })

  const [cvFile, setCvFile] = useState<File | null>(null)
  const [cvMsg, setCvMsg] = useState<string | null>(null)

  const uploadCv = async () => {
    if (!cvFile) return
    setCvMsg("Uploading…")
    try {
      const res = await fetch(
        `/api/profile/cv?filename=${encodeURIComponent(cvFile.name)}`,
        { method: "POST", headers: { "Content-Type": cvFile.type }, body: cvFile },
      )
      if (!res.ok) throw new Error("Upload failed")
      const data = await res.json()
      setCvMsg(`Uploaded ${data.filename}`)
      qc.invalidateQueries({ queryKey: ["profile"] })
    } catch (e: any) {
      setCvMsg(`Error: ${e.message}`)
    }
  }

  const field = (name: string, label: string, type = "text") => (
    <div className="mb-4">
      <label className="block text-sm text-ink-300 mb-1.5">{label}</label>
      <input
        type={type}
        value={form[name] ?? ""}
        onChange={e => setForm({ ...form, [name]: e.target.value })}
        className="w-full px-3 py-2 rounded-lg bg-ink-900 border border-ink-800 text-white text-sm focus:outline-none focus:border-accent"
      />
    </div>
  )

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {/* Profile */}
      <div className="bg-ink-900 rounded-xl border border-ink-800 p-6 mb-6">
        <h2 className="text-sm font-semibold text-ink-300 mb-4">Profile</h2>
        {field("fullName", "Full name")}
        {field("email", "Email", "email")}
        {field("phone", "Phone")}
        {field("location", "Location")}
        {field("targetRoles", "Target roles")}
        {field("targetLocations", "Target locations")}
        {field("skills", "Skills")}
        {field("workAuth", "Work authorization")}
        <button
          onClick={() => save.mutate()}
          className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-600"
        >
          {save.isPending ? "Saving…" : "Save profile"}
        </button>
        {save.isSuccess && <span className="ml-3 text-sm text-emerald-400">Saved</span>}
      </div>

      {/* CV */}
      <div className="bg-ink-900 rounded-xl border border-ink-800 p-6">
        <h2 className="text-sm font-semibold text-ink-300 mb-2">CV / Résumé</h2>
        {profile?.cvFilename && (
          <div className="text-sm text-ink-500 mb-3">
            Current: {profile.cvFilename}{" "}
            {profile.cvUploadedAt && `(${new Date(profile.cvUploadedAt).toLocaleDateString()})`}{" "}
            <a href="/api/profile/cv" className="text-accent hover:underline">Download</a>
          </div>
        )}
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={e => setCvFile(e.target.files?.[0] ?? null)}
            className="text-sm text-ink-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink-800 file:text-white file:cursor-pointer"
          />
          <button
            onClick={uploadCv}
            disabled={!cvFile}
            className="px-4 py-2 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-700 disabled:opacity-50"
          >
            Upload
          </button>
        </div>
        {cvMsg && <div className="mt-2 text-sm text-ink-400">{cvMsg}</div>}
      </div>
    </div>
  )
}

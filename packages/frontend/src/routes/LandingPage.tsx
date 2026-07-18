import { Link } from "@tanstack/react-router"
import { Button } from "@agent-harness/ui"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@agent-harness/ui"

// Public marketing landing page — the front door at `/`.
//
// The whole page is dark-first, using the semantic tokens from index.css so it
// stays consistent with the rest of the app and any future theme work.
export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Nav bar ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 backdrop-blur bg-background/80 border-b border-border">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg">
            <span className="inline-block size-7 rounded-md bg-primary" aria-hidden />
            Job Agent
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/signup">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, hsl(var(--primary) / 0.25), transparent 70%)",
          }}
          aria-hidden
        />
        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground mb-6">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            Your job search, on autopilot
          </div>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.05]">
            An AI agent that finds jobs,
            <br />
            scores them, and writes the
            <span className="text-primary"> cover letters</span>.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Stop scrolling job boards for hours. Job Agent searches the boards you
            trust, filters to the roles that actually fit, and drafts a tailored
            cover letter for each one — while you sleep.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/signup">Get started — free</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/login">I have an account</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            No credit card. Set up your profile in under two minutes.
          </p>
        </div>
      </section>

      {/* ── Problem → Solution ─────────────────────────────── */}
      <section className="border-y border-border bg-secondary/20">
        <div className="max-w-5xl mx-auto px-6 py-16 grid md:grid-cols-2 gap-10 items-center">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">
              The old way is exhausting.
            </h2>
            <p className="text-muted-foreground">
              Ten tabs open. The same role re-posted across five sites. A cover
              letter you start from blank every single time. By the weekend you've
              applied to three roles and you're burnt out.
            </p>
          </div>
          <Card className="bg-card">
            <CardHeader>
              <CardTitle>The Job Agent way</CardTitle>
              <CardDescription>
                Describe what you want once. Let the agent do the drudge work.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>✓ Searches your allowlisted boards on a schedule.</p>
              <p>✓ Scores every listing against your profile.</p>
              <p>✓ Drafts a cover letter you can edit in one click.</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Feature grid ───────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3">
          Built for serious job seekers
        </h2>
        <p className="text-center text-muted-foreground mb-12 max-w-2xl mx-auto">
          Everything you need to run a deliberate, high-quality search — not a
          spray-and-pray numbers game.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => (
            <Card key={f.title}>
              <CardHeader>
                <div className="text-2xl mb-1" aria-hidden>
                  {f.icon}
                </div>
                <CardTitle className="text-base">{f.title}</CardTitle>
                <CardDescription>{f.desc}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────── */}
      <section className="border-y border-border bg-secondary/20">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-12">
            Three steps to your next role
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {STEPS.map((s, i) => (
              <div key={s.title} className="relative">
                <div className="size-9 rounded-full bg-primary text-primary-foreground font-bold flex items-center justify-center mb-4">
                  {i + 1}
                </div>
                <h3 className="font-semibold mb-1">{s.title}</h3>
                <p className="text-sm text-muted-foreground">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Trust / security ───────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-16 text-center">
        <h2 className="text-xl font-bold mb-3">Your data stays yours</h2>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Every account runs in its own isolated runtime — your profile, jobs, and
          memory are never shared with another user. CVs live in encrypted object
          storage, not in a shared database. You can export or delete everything
          from Settings at any time.
        </p>
      </section>

      {/* ── Final CTA ──────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Let the agent go to work.
          </h2>
          <p className="text-muted-foreground mb-8">
            Set up your profile once. Wake up to a shortlist of roles that
            actually match.
          </p>
          <Button asChild size="lg">
            <Link to="/signup">Create your free account</Link>
          </Button>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="inline-block size-4 rounded bg-primary" aria-hidden />
            Job Agent
          </div>
          <p>© {new Date().getFullYear()} Job Agent. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}

const FEATURES = [
  {
    icon: "🔎",
    title: "Autonomous job discovery",
    desc: "The agent crawls the boards you allowlist, on the schedule you set, and surfaces only what's new.",
  },
  {
    icon: "🎯",
    title: "Match scoring",
    desc: "Every listing is scored against your target roles, skills, seniority, and work auth — so the best rises to the top.",
  },
  {
    icon: "✍️",
    title: "Cover letters, drafted",
    desc: "A tailored first draft for every role, grounded in your profile and the job description. Edit and send.",
  },
  {
    icon: "🔗",
    title: "You pick the sources",
    desc: "Bring your own trusted job boards. The agent never searches a site you haven't explicitly approved.",
  },
  {
    icon: "🧠",
    title: "Memory that compounds",
    desc: "Notes and preferences persist across runs. The agent learns what you liked and what to skip next time.",
  },
  {
    icon: "🔍",
    title: "Full trace transparency",
    desc: "Every search, score, and decision is logged. See exactly why a role was picked — or rejected.",
  },
]

const STEPS = [
  {
    title: "Set your profile",
    desc: "Tell the agent your target roles, seniority, skills, and work authorization. Upload your CV once.",
  },
  {
    title: "It searches & scores",
    desc: "On your schedule, the agent discovers new listings, scores each one, and queues the best matches.",
  },
  {
    title: "Review & apply",
    desc: "Approve the shortlist, tweak the drafted cover letter, and apply. Repeat weekly without the grind.",
  },
]

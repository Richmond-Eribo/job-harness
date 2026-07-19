import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { Button } from "@agent-harness/ui"

// Public marketing landing page — `/`.
//
// Design: big-type minimal, in the studio tradition (Vercel / Linear).
// One neo-grotesque (Inter) drives the whole page; the hero headline spans
// the viewport. Mono is the "data voice" — eyebrows, numerals, and the trace
// card that sits beneath the hero statement as a live readout. Black/zinc
// ground, blue reserved strictly as the accent (never a surface).

export function LandingPage() {
  return (
    <div className="min-h-screen bg-landing-ground text-landing-ink antialiased selection:bg-landing-accent/30 selection:text-landing-ink">
      {/* ── Nav ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-landing-hairline bg-landing-ground/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[88rem] items-center justify-between px-6 lg:px-10">
          <Link to="/" className="flex items-center gap-3 text-landing-ink">
            <span
              className="grid size-6 place-items-center rounded-[5px] bg-landing-ink text-[11px] font-bold text-landing-ground"
              aria-hidden
            >
              J
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.01em]">
              Job Agent
            </span>
            <span className="ml-1 hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-landing-ink-faint sm:inline-flex">
              <span className="size-1 rounded-full bg-landing-accent" aria-hidden />
              v1
            </span>
          </Link>
          <div className="flex items-center gap-1">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-landing-ink-muted hover:bg-white/5 hover:text-landing-ink"
            >
              <Link to="/login">Sign in</Link>
            </Button>
            <Button
              asChild
              size="sm"
              className="bg-landing-accent-strong text-white hover:bg-landing-accent"
            >
              <Link to="/signup">
                Get started
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero — full-width typographic statement ──────────────────── */}
      <section className="relative overflow-hidden">
        {/* Faint blue ambient at the top — barely there, reinforces "live" */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[60vh]"
          aria-hidden
          style={{
            background:
              "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--landing-accent) 10%, transparent), transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-[88rem] px-6 pb-16 pt-20 sm:pt-28 lg:px-10 lg:pb-20 lg:pt-36">
          {/* Eyebrow */}
          <p className="eyebrow mb-8 flex items-center gap-2.5 text-landing-ink-muted">
            <span className="size-1.5 rounded-full bg-landing-accent" aria-hidden />
            Autonomous job search
          </p>

          {/* The statement — spans the viewport */}
          <h1 className="text-display-1 max-w-[16ch] text-landing-ink">
            A job search
            <br />
            that runs
            <br />
            <span className="text-landing-accent">itself.</span>
          </h1>

          {/* Supporting line + CTAs — beneath the headline, not beside */}
          <div className="mt-12 flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-xl text-[17px] leading-[1.6] text-landing-ink-muted lg:text-[19px] lg:leading-[1.55]">
              The agent reads the boards you trust, scores every listing against
              your profile, and drafts a cover letter for each match — while you
              do literally anything else.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                asChild
                size="lg"
                className="bg-landing-accent-strong text-white hover:bg-landing-accent"
              >
                <Link to="/signup">
                  Start free
                  <ArrowRight />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="text-landing-ink-muted hover:bg-white/5 hover:text-landing-ink"
              >
                <Link to="/login">I have an account</Link>
              </Button>
            </div>
          </div>

          <p className="eyebrow mt-7 text-landing-ink-faint">
            No card · 2-minute setup · cancel anytime
          </p>
        </div>
      </section>

      {/* ── The trace — wide live readout beneath the statement ───────── */}
      <section className="border-t border-landing-hairline">
        <TraceCard />
      </section>

      {/* ── Proof bar ────────────────────────────────────────────────── */}
      <section className="border-y border-landing-hairline bg-landing-surface/30">
        <div className="mx-auto max-w-[88rem] px-6 py-5 lg:px-10">
          <p className="eyebrow text-center text-landing-ink-muted">
            <span className="text-landing-ink-faint">Reads the boards you trust —</span>{" "}
            <span className="text-landing-ink normal-case tracking-normal">Hacker News</span>
            <span className="text-landing-ink-faint"> · </span>
            <span className="text-landing-ink normal-case tracking-normal">LinkedIn</span>
            <span className="text-landing-ink-faint"> · </span>
            <span className="text-landing-ink normal-case tracking-normal">your own list</span>
          </p>
        </div>
      </section>

      {/* ── How it works — big numerals as architecture ──────────────── */}
      <section className="mx-auto max-w-[88rem] px-6 py-24 lg:px-10 lg:py-32">
        <p className="eyebrow mb-6 text-landing-ink-faint">How it works</p>
        <h2 className="text-display-2 max-w-[20ch] text-landing-ink">
          Three steps. Then you stop scrolling job boards.
        </h2>

        <div className="mt-16 flex flex-col">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="grid grid-cols-1 gap-y-4 border-t border-landing-hairline py-10 sm:grid-cols-[6rem_1fr] sm:gap-x-12 lg:py-14"
            >
              {/* Oversized mono numeral — the architecture, not decoration */}
              <div className="text-numeral text-landing-ink-faint">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="max-w-2xl">
                <h3 className="text-display-2 text-[1.75rem] text-landing-ink sm:text-[2rem]">
                  {step.title}
                </h3>
                <p className="mt-4 text-[16px] leading-[1.65] text-landing-ink-muted lg:text-[17px]">
                  {step.body}
                </p>
                <p className="eyebrow mt-5 text-landing-accent">{step.tag}</p>
              </div>
            </div>
          ))}
          <div className="border-t border-landing-hairline" />
        </div>
      </section>

      {/* ── Trust ────────────────────────────────────────────────────── */}
      <section className="border-t border-landing-hairline bg-landing-surface/30">
        <div className="mx-auto max-w-2xl px-6 py-24 text-center lg:py-32">
          <p className="eyebrow text-landing-ink-faint">Your data stays yours</p>
          <p className="mt-7 text-[17px] leading-[1.65] text-landing-ink-muted lg:text-[19px] lg:leading-[1.6]">
            Every account runs in its own isolated runtime. Your profile, jobs,
            and memory are never shared with another user. CVs live in encrypted
            object storage, not a shared database. Export or delete everything
            from Settings whenever you want.
          </p>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[88rem] px-6 py-32 text-center lg:px-10 lg:py-40">
        <h2 className="text-display-1 mx-auto max-w-[14ch] text-landing-ink">
          Let the agent
          <br />
          <span className="text-landing-accent">go to work.</span>
        </h2>
        <div className="mt-12 flex justify-center">
          <Button
            asChild
            size="lg"
            className="bg-landing-accent-strong text-white hover:bg-landing-accent"
          >
            <Link to="/signup">
              Create your free account
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="border-t border-landing-hairline">
        <div className="mx-auto flex max-w-[88rem] flex-col items-center justify-between gap-3 px-6 py-8 lg:flex-row lg:px-10">
          <div className="flex items-center gap-2.5">
            <span
              className="grid size-5 place-items-center rounded-[4px] bg-landing-ink text-[10px] font-bold text-landing-ground"
              aria-hidden
            >
              J
            </span>
            <span className="text-[13px] text-landing-ink-muted">Job Agent</span>
          </div>
          <p className="eyebrow text-landing-ink-faint">
            © {new Date().getFullYear()} Job Agent
          </p>
        </div>
      </footer>
    </div>
  )
}

// ── The signature: a wide agent-trace readout ─────────────────────────────
//
// Sits as a full-width inset directly beneath the hero statement, so it reads
// as a live readout of what the headline just claimed. Structurally honest —
// rendered in the product's own event-log vernacular (mono, tabular nums,
// timestamp / action / source / outcome). Blue marks only positive events and
// the "live" indicator.
const TRACE_EVENTS = [
  { t: "09:41", action: "search", source: "hn/whoishiring", n: "47 found" },
  { t: "09:41", action: "score", source: "vs. your profile", n: "47 → 12" },
  { t: "09:42", action: "draft", source: "cover letters", n: "3 written" },
  { t: "09:42", action: "queue", source: "for your review", n: "12 ready" },
] as const

function TraceCard() {
  return (
    <div className="mx-auto max-w-[88rem] px-6 py-16 lg:px-10 lg:py-20">
      <div className="overflow-hidden rounded-xl border border-landing-hairline bg-landing-surface-2 shadow-2xl shadow-black/40">
        {/* Run header / window chrome */}
        <div className="flex items-center justify-between border-b border-landing-hairline px-5 py-3.5 sm:px-7">
          <div className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-full bg-landing-hairline" aria-hidden />
            <span className="size-2.5 rounded-full bg-landing-hairline" aria-hidden />
            <span className="size-2.5 rounded-full bg-landing-hairline" aria-hidden />
            <span className="ml-3 eyebrow text-landing-ink-faint">run.log</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-landing-ink-faint">
            <span className="hidden sm:inline">RUN · just now</span>
            <span className="flex items-center gap-1.5 text-landing-accent">
              <span className="size-1.5 animate-pulse rounded-full bg-landing-accent" aria-hidden />
              live
            </span>
          </div>
        </div>

        {/* Event log — wide grid, scales up on larger screens */}
        <div className="flex flex-col px-5 py-4 font-mono text-[13px] sm:px-7 sm:text-[14px]">
          {TRACE_EVENTS.map((ev, i) => (
            <div
              key={`${ev.t}-${ev.action}`}
              className="grid grid-cols-[3.5rem_5rem_1fr_auto] items-center gap-x-3 border-b border-landing-hairline/60 py-3 last:border-b-0 sm:grid-cols-[4rem_5.5rem_1fr_auto] sm:gap-x-6 sm:py-3.5"
              style={{
                // Stagger the entrance so the trace "types itself" in. The
                // global prefers-reduced-motion rule clamps this to instant.
                animation:
                  "trace-in 480ms cubic-bezier(0.22, 1, 0.36, 1) both",
                animationDelay: `${200 + i * 120}ms`,
              }}
            >
              <span className="text-landing-ink-faint tabular-nums">{ev.t}</span>
              <span className="text-landing-ink">{ev.action}</span>
              <span className="truncate text-landing-ink-muted">{ev.source}</span>
              <span className="text-landing-accent tabular-nums">{ev.n}</span>
            </div>
          ))}
        </div>

        {/* Footer / open the trace */}
        <Link
          to="/signup"
          className="flex items-center justify-between border-t border-landing-hairline px-5 py-3.5 text-[13px] text-landing-ink-muted transition-colors hover:bg-white/[0.03] hover:text-landing-ink sm:px-7"
        >
          <span className="eyebrow text-landing-ink-muted">Open the trace</span>
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  )
}

// Inline content for "how it works". Numbers are justified here: this IS an
// ordered process (set profile → agent searches → you review), not decoration.
const STEPS = [
  {
    title: "Set your profile once.",
    body: "Tell the agent your target roles, seniority, skills, and work authorization. Upload your CV. The richer the profile, the sharper the targeting — edit it any time from Settings.",
    tag: "you · 2 min",
  },
  {
    title: "It searches and scores.",
    body: "On the schedule you set, the agent reads your allowlisted boards, scores every new listing against your profile, and queues the ones that actually fit. No spray-and-pray.",
    tag: "agent · async",
  },
  {
    title: "You review and apply.",
    body: "Approve the shortlist. Tweak the drafted cover letter. Apply. Repeat weekly without the grind — the agent remembers what you liked and what to skip.",
    tag: "you · 10 min",
  },
]

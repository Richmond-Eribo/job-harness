import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { Button } from "@agent-harness/ui"

// Public marketing landing page — `/`.
//
// Design (§10.2 light identity): white/#F8FAFC ground, one blue accent doing
// all the emphasis work, flat 1px borders, zero gradients. Geist drives the
// display type; mono stays the "data voice" — eyebrows, numerals, and the
// trace readout beneath the hero statement.

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/20 selection:text-foreground">
      {/* ── Nav ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[88rem] items-center justify-between px-6 lg:px-10">
          <Link to="/" className="flex items-center gap-3 text-foreground">
            <span
              className="grid size-6 place-items-center rounded-[5px] bg-primary text-[11px] font-bold text-white"
              aria-hidden
            >
              J
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.01em]">
              Job Agent
            </span>
            <span className="ml-1 hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70 sm:inline-flex">
              <span className="size-1 rounded-full bg-primary" aria-hidden />
              v1
            </span>
          </Link>
          <div className="flex items-center gap-1">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/signup">
                Get started
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero — full-width typographic statement ──────────────────── */}
      <section>
        <div className="mx-auto max-w-[88rem] px-6 pb-16 pt-20 sm:pt-28 lg:px-10 lg:pb-20 lg:pt-36">
          {/* Eyebrow */}
          <p className="eyebrow mb-8 flex items-center gap-2.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            Autonomous job search
          </p>

          {/* The statement — spans the viewport */}
          <h1 className="text-display-1 max-w-[16ch] text-foreground">
            A job search
            <br />
            that runs
            <br />
            <span className="text-primary">itself.</span>
          </h1>

          {/* Supporting line + CTAs — beneath the headline, not beside */}
          <div className="mt-12 flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-xl text-[17px] leading-[1.6] text-muted-foreground lg:text-[19px] lg:leading-[1.55]">
              The agent reads the boards you trust, scores every listing against
              your profile, and drafts a tailored CV and cover letter for each
              match — while you do literally anything else.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg">
                <Link to="/signup">
                  Start free
                  <ArrowRight />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Link to="/login">I have an account</Link>
              </Button>
            </div>
          </div>

          <p className="eyebrow mt-7 text-muted-foreground/70">
            No card · 2-minute setup · cancel anytime
          </p>
        </div>
      </section>

      {/* ── The trace — wide live readout beneath the statement ───────── */}
      <section className="border-t border-border">
        <TraceCard />
      </section>

      {/* ── Proof bar ────────────────────────────────────────────────── */}
      <section className="border-y border-border bg-muted/40">
        <div className="mx-auto max-w-[88rem] px-6 py-5 lg:px-10">
          <p className="eyebrow text-center text-muted-foreground">
            <span className="text-muted-foreground/70">Reads the boards you trust —</span>{" "}
            <span className="text-foreground normal-case tracking-normal">Hacker News</span>
            <span className="text-muted-foreground/70"> · </span>
            <span className="text-foreground normal-case tracking-normal">LinkedIn</span>
            <span className="text-muted-foreground/70"> · </span>
            <span className="text-foreground normal-case tracking-normal">your own list</span>
          </p>
        </div>
      </section>

      {/* ── How it works — big numerals as architecture ──────────────── */}
      <section className="mx-auto max-w-[88rem] px-6 py-24 lg:px-10 lg:py-32">
        <p className="eyebrow mb-6 text-muted-foreground/70">How it works</p>
        <h2 className="text-display-2 max-w-[20ch] text-foreground">
          Three steps. Then you stop scrolling job boards.
        </h2>

        <div className="mt-16 flex flex-col">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="grid grid-cols-1 gap-y-4 border-t border-border py-10 sm:grid-cols-[6rem_1fr] sm:gap-x-12 lg:py-14"
            >
              {/* Oversized mono numeral — the architecture, not decoration */}
              <div className="text-numeral text-muted-foreground/40">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="max-w-2xl">
                <h3 className="text-display-2 text-[1.75rem] text-foreground sm:text-[2rem]">
                  {step.title}
                </h3>
                <p className="mt-4 text-[16px] leading-[1.65] text-muted-foreground lg:text-[17px]">
                  {step.body}
                </p>
                <p className="eyebrow mt-5 text-primary">{step.tag}</p>
              </div>
            </div>
          ))}
          <div className="border-t border-border" />
        </div>
      </section>

      {/* ── Trust ────────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-2xl px-6 py-24 text-center lg:py-32">
          <p className="eyebrow text-muted-foreground/70">Your data stays yours</p>
          <p className="mt-7 text-[17px] leading-[1.65] text-muted-foreground lg:text-[19px] lg:leading-[1.6]">
            Every account runs in its own isolated runtime. Your profile, jobs,
            and memory are never shared with another user. CVs live in encrypted
            object storage, not a shared database. Export or delete everything
            from Settings whenever you want.
          </p>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[88rem] px-6 py-32 text-center lg:px-10 lg:py-40">
        <h2 className="text-display-1 mx-auto max-w-[14ch] text-foreground">
          Let the agent
          <br />
          <span className="text-primary">go to work.</span>
        </h2>
        <div className="mt-12 flex justify-center">
          <Button asChild size="lg">
            <Link to="/signup">
              Create your free account
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[88rem] flex-col items-center justify-between gap-3 px-6 py-8 lg:flex-row lg:px-10">
          <div className="flex items-center gap-2.5">
            <span
              className="grid size-5 place-items-center rounded-[4px] bg-primary text-[10px] font-bold text-white"
              aria-hidden
            >
              J
            </span>
            <span className="text-[13px] text-muted-foreground">Job Agent</span>
          </div>
          <p className="eyebrow text-muted-foreground/70">
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
  { t: "09:42", action: "tailor", source: "CV + cover letters", n: "3 drafted" },
  { t: "09:42", action: "queue", source: "for your review", n: "12 ready" },
] as const

function TraceCard() {
  return (
    <div className="mx-auto max-w-[88rem] px-6 py-16 lg:px-10 lg:py-20">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Run header / window chrome */}
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-3.5 sm:px-7">
          <div className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-full bg-border" aria-hidden />
            <span className="size-2.5 rounded-full bg-border" aria-hidden />
            <span className="size-2.5 rounded-full bg-border" aria-hidden />
            <span className="ml-3 eyebrow text-muted-foreground/70">run.log</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70">
            <span className="hidden sm:inline">RUN · just now</span>
            <span className="flex items-center gap-1.5 text-primary">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
              live
            </span>
          </div>
        </div>

        {/* Event log — wide grid, scales up on larger screens */}
        <div className="flex flex-col px-5 py-4 font-mono text-[13px] sm:px-7 sm:text-[14px]">
          {TRACE_EVENTS.map((ev, i) => (
            <div
              key={`${ev.t}-${ev.action}`}
              className="grid grid-cols-[3.5rem_5rem_1fr_auto] items-center gap-x-3 border-b border-border/60 py-3 last:border-b-0 sm:grid-cols-[4rem_5.5rem_1fr_auto] sm:gap-x-6 sm:py-3.5"
              style={{
                // Stagger the entrance so the trace "types itself" in. The
                // global prefers-reduced-motion rule clamps this to instant.
                animation:
                  "trace-in 480ms cubic-bezier(0.22, 1, 0.36, 1) both",
                animationDelay: `${200 + i * 120}ms`,
              }}
            >
              <span className="text-muted-foreground/70 tabular-nums">{ev.t}</span>
              <span className="text-foreground">{ev.action}</span>
              <span className="truncate text-muted-foreground">{ev.source}</span>
              <span className="text-primary tabular-nums">{ev.n}</span>
            </div>
          ))}
        </div>

        {/* Footer / open the trace */}
        <Link
          to="/signup"
          className="flex items-center justify-between border-t border-border px-5 py-3.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:px-7"
        >
          <span className="eyebrow text-muted-foreground">Open the trace</span>
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
    body: "Approve the shortlist. Tweak the tailored CV and drafted cover letter. Apply — the agent can even help you fill the form in your own browser. Repeat weekly without the grind.",
    tag: "you · 10 min",
  },
]

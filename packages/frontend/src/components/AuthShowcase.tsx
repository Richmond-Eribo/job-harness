import { Link } from "@tanstack/react-router"
import { Search } from "lucide-react"

// AuthShowcase — the left 50% of the split-screen auth layout (signup,
// onboarding, forgot-password). Mirrors the landing page's design language:
// big-type minimal, blue reserved as the accent, mono micro-labels, the same
// "agent that runs itself" thesis. Hidden on small screens (the form takes
// the full viewport below sm) so it never crowds the inputs on mobile.
export function AuthShowcase() {
  return (
    <aside
      className="relative hidden lg:flex lg:w-1/2 flex-col justify-between overflow-hidden border-r border-border bg-background p-10 xl:p-14"
      aria-hidden
    >
      {/* Faint blue ambient — same treatment as the landing hero */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 60% at 30% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 70%)",
        }}
      />

      {/* Brand */}
      <Link to="/" className="relative flex items-center gap-2.5 text-foreground">
        <span
          className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"
          aria-hidden
        >
          <Search className="size-4" strokeWidth={2.5} />
        </span>
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Job Agent</span>
      </Link>

      {/* Thesis — big type, the page's actual message */}
      <div className="relative max-w-md">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Autonomous job search
        </p>
        <h2 className="mt-5 font-display text-[2.5rem] font-semibold leading-[0.98] tracking-[-0.035em] text-foreground xl:text-[3rem]">
          A job search that{" "}
          <span className="text-primary">runs itself.</span>
        </h2>
        <p className="mt-6 text-[15px] leading-relaxed text-muted-foreground">
          The agent reads the boards you trust, scores every listing against
          your profile, and drafts a cover letter for each match — while you do
          literally anything else.
        </p>
      </div>

      {/* Trust line */}
      <div className="relative flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden />
        No card · 2-minute setup · cancel anytime
      </div>
    </aside>
  )
}

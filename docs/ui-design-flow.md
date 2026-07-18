# Harness — What It Is & How You Drive It (2026-07-17)

A plain-language note on the **goal of this project** and **how an operator uses
the dashboard**. No code, no internals — just what it does and how you steer it.

---

## What this is

**Harness is an autonomous agent that runs on a schedule to find and pursue jobs
on your behalf.**

Left to its own, it will wake up on a cron, work through its goal, and do useful
job-hunting work for you:

- **Search job sites** for listings matching your target roles and locations —
  including login-walled sites like LinkedIn, Reed, Indeed, Glassdoor. For those,
  it drives your *real*, already-logged-in Chrome through a browser extension, so
  it sees exactly what you'd see.
- **Save and rank** the listings it finds, keeping a pipeline of real, grounded
  jobs (never invented).
- **Draft cover letters** tailored to specific postings.
- **Track follow-ups** so nothing you started gets forgotten.

It runs in a loop: each "run" is one end-to-end pass — think, search, read, save,
draft — and every run is recorded so you can see exactly what it did and why.

**The dashboard is the operator's control panel.** You're not a passenger — you
set the goal and the budget, you decide which sites it may touch, you watch it
work in real time, you manage what it produces, and you step in to approve or
correct. The whole UI exists to answer three questions, in this order:

1. **Is it working?**
2. **What's it doing right now?**
3. **What has it produced — and what needs me?**

Everything below maps back to those three questions.

---

## 1. Is it working? (The heartbeat)

The moment the dashboard loads, your eye goes to one place: the **status badge**
in the top bar. It has five states, and only one is loud:

- **IDLE** — quiet, dim. Nothing is running. This is the resting state.
- **RUNNING** — amber, gently pulsing. The agent is mid-run.
- **PAUSED** — a muted caution color. You (or a schedule) paused it.
- **DONE** — green. The last run finished cleanly.
- **ERROR** — red. Something went wrong on the last run.

Amber is deliberately reserved across the whole app for *one* meaning: **"the
agent is doing something right now."** So when a run is active, three things pulse
in unison — the status badge, the notification bell dot, and the live dot on a
running transcript. You don't have to read anything to know it's working; the
screen itself comes alive. When nothing is running, the UI goes still and quiet.

The **Run** and **Pause** buttons in the top bar let you start a pass on demand
or hold it. Beyond that, the agent mostly runs on its own schedule.

---

## 2. What's it doing right now?

When the badge is pulsing, two screens tell you what it's actually up to.

### Overview → "Live activity"

The Overview page is your daily cockpit, and while a run is active its bottom
card becomes a **live activity feed** — the last few things the agent did,
streaming in every few seconds. It's the at-a-glance "ok, it's searching Reed…
now it's reading a posting… now it saved one." You get the shape of the run
without leaving the page.

Overview also shows the headline numbers: jobs in the pipeline, due follow-ups,
and the agent's current status, plus a token-spend chart so you can see how much
the run is costing.

### Traces → a single run

When you want the full story, click any run (from the Traces list, a
notification, or the live feed) to open its **transcript**. This is the most
detailed screen in the app and it updates live while the run is happening.

The transcript is organized **step by step** — each step is one turn of the
agent's reasoning loop, and within each step you see, in order:

- the **system prompt** and **messages sent** (what it was told / asked),
- the agent's **reasoning** (its thinking),
- its **tool calls** — *search this site*, *fetch this page*, *save this job* —
  each one paired with the **result** it got back,
- and any **text response**.

Crucially, **sub-agent activity is nested**. When the main agent delegates ("go
discover jobs"), everything the job-search sub-agent did internally — its own
searches, fetches, saves, reasoning — appears *indented under* that one
delegating call. So you can drill from a high-level "discover_jobs" all the way
down into the real searches and pages it read. Nothing is a black box.

Each step is color-coded by *which* agent did it (the main harness vs. the
job-agent vs. the browser), using the same signal colors as the rest of the app.
Steps are collapsible, so you can expand the interesting bits and skip the rest.

When the run ends, the transcript stops polling and freezes — it's a permanent,
replayable record of that run.

---

## 3. What has it produced — and what needs me?

This is where you stop watching and start acting.

### Jobs — the pipeline (Kanban)

The Jobs page is the agent's **output**, laid out as a Kanban board you control.
Every listing the agent saves lands here and moves left-to-right through stages:

**New → Interested → Applied → Interviewing → Offer**

You can **drag** a job between stages (which updates its real status), click a
card to open a detail drawer with the full posting, and generate or read a
**cover letter** for it. The board is the central artifact: it's what the agent
produces, and it's what you curate.

The toolbar above the board lets you **add a job manually**, manage **job
sources** (the sites the agent is allowed to browse), edit your **profile** (CV,
target roles/locations/skills — this is what the agent searches against), or kick
off a fresh discovery run.

### Overview → due follow-ups

The Overview page surfaces **follow-ups that are due** — jobs in your pipeline
where the agent thinks it's time to nudge or revisit. This is the "what needs me
right now" list, so overdue actions don't slip through.

---

## 4. Setting it up (Settings)

Before the agent can do any of this usefully, you configure it once on the
Settings page:

- **The goal** — what you want the agent to work toward (your job-search mission).
  You can write it yourself or have the agent synthesize one from your profile.
- **The budget** — max steps per run and a token cap, so a runaway run can't
  spend endlessly.
- **The model** — which LLM powers it, and an optional custom provider.
- **Schedules** — the cron expressions that decide when the agent wakes and runs
  on its own (e.g. every weekday morning).
- **Job sources** — the **allow-list of websites** the agent is permitted to
  browse. This is a deliberate gate: the agent's search tools refuse any site not
  on this list. Each source has a base URL and a search-URL template.
- **Browser** — the status of the real-Chrome connection (via the extension) and
  a manual probe to test that a URL loads through it.
- **Profile** — your CV/resume, target roles, target locations, key skills, and
  preferences. This is the raw material the agent searches with and writes from.

---

## 5. Keeping tabs over time

Two pages exist for longer-term oversight:

- **Logs** — an append-only **audit trail** of the last actions across all runs.
  Click any entry for the detail. This is your "what happened, in order" record.
- **Memory** — the agent's **editable knowledge base**, split into two halves:
  - **Operator notes** — facts *you* write that the agent should always remember
    (e.g. "I'm only interested in remote roles over £60k").
  - **Agent memory** — facts the *agent* has recalled and stored; you can read
    and forget (delete) any of them if it's holding onto something wrong.

Memory is how you correct the agent's worldview without editing prompts.

---

## 6. How it feels to use

A few design choices add up to the experience:

- **Navigation is seamless.** Moving between pages doesn't reload the screen or
  throw you back to the top — it swaps just the page content instantly, with
  scroll preserved. Links are still real links, so back-button, Cmd-click-to-
  new-tab, and bookmarks all behave correctly.
- **Everything live-updates without reloading.** The status badge, the active
  page, and an in-progress transcript all refresh on their own (roughly every few
  seconds) and reconcile in place — so watching a run feels like watching it
  happen, not like refreshing a page. Lists you're scrolled through don't jump.
- **The look is a quiet "operator console."** Dark, warm, instrument-like — mono
  type for all the data, thin scrollbars, and that one reserved amber for
  "live." It's built to be left open on a second monitor and read at a glance,
  not to dazzle.

---

## The short version

You point the agent at a goal and a set of allowed sites; it wakes on a schedule
and does the tedious parts of a job hunt — searching, reading, saving, drafting,
following up — using your real browser where needed. The dashboard lets you
**see that it's working** (the pulsing status), **follow what it's doing**
(live feed + step-by-step transcript), **manage what it produced** (the Kanban
pipeline + follow-ups), and **steer its worldview** (goal, sources, profile,
memory). You stay in control; the agent does the legwork.

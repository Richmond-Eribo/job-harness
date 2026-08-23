// -----------------------------------------------------------------------------
// prompt-sync — drift guard between the canonical prompts/*.md files and the
// inlined copies in prompt-loader.ts.
// -----------------------------------------------------------------------------
// Wrangler's esbuild config can't `?raw`-import .md files, so soul.md and
// default.md exist TWICE: the canonical files in prompts/ (edited by humans)
// and inlined template strings in src/agents/prompt-loader.ts (what actually
// runs). Nothing forces them to stay identical — this test does. Normalize
// CRLF (Windows checkouts) and trailing whitespace before comparing.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { SOUL_MD, DEFAULT_MD } from "../agents/prompt-loader"

const here = dirname(fileURLToPath(import.meta.url))
// packages/hono-worker/src/test → repo root
const repoRoot = resolve(here, "../../../..")

function canonical(rel: string): string {
  const raw = readFileSync(resolve(repoRoot, rel), "utf8")
  return raw.replace(/\r\n/g, "\n").trim()
}

function inlined(s: string): string {
  return s.replace(/\r\n/g, "\n").trim()
}

describe("prompt-loader stays in sync with prompts/*.md", () => {
  it("SOUL_MD matches prompts/soul.md byte-for-byte (normalized)", () => {
    expect(inlined(SOUL_MD)).toBe(canonical("prompts/soul.md"))
  })

  it("DEFAULT_MD matches prompts/default.md byte-for-byte (normalized)", () => {
    expect(inlined(DEFAULT_MD)).toBe(canonical("prompts/default.md"))
  })

  it("fails loudly with a hint when drift is detected", () => {
    // Guards the guard: the assertion message should point the fixer at BOTH
    // files. (Kept as its own case so a drift failure reads actionable.)
    const soulDrift = inlined(SOUL_MD) !== canonical("prompts/soul.md")
    const defaultDrift =
      inlined(DEFAULT_MD) !== canonical("prompts/default.md")
    if (soulDrift || defaultDrift) {
      throw new Error(
        "Prompt drift detected — copy the canonical prompts/*.md content into " +
          "src/agents/prompt-loader.ts (wrangler can't ?raw-import .md files).",
      )
    }
  })
})

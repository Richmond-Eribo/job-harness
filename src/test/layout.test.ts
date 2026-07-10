import { describe, it, expect } from "vitest"

/**
 * Tests for the Layout component HTML structure.
 * Verifies the <script> tag is correctly placed inside <body>.
 */

describe("Layout HTML structure", () => {
  it("places script tag inside body, not after it", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Layout.tsx"),
      "utf-8",
    )

    // Find the script tag and body closing tag positions
    const scriptPos = src.indexOf('<script src="/js/dashboard.js"')
    const bodyClosePos = src.indexOf("</body>")

    // Script must come BEFORE </body>
    expect(scriptPos).toBeGreaterThan(-1)
    expect(bodyClosePos).toBeGreaterThan(-1)
    expect(scriptPos).toBeLessThan(bodyClosePos)
  })

  it("has proper HTML5 doctype via jsxRenderer", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Layout.tsx"),
      "utf-8",
    )

    expect(src).toContain("docType:")
    expect(src).toContain("<!DOCTYPE html>")
  })

  it("links CSS from assets binding", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Layout.tsx"),
      "utf-8",
    )

    expect(src).toContain('href="/css/dashboard.css"')
  })

  it("links client JS from assets binding", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Layout.tsx"),
      "utf-8",
    )

    expect(src).toContain('src="/js/dashboard.js"')
  })

  it("has proper meta tags", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Layout.tsx"),
      "utf-8",
    )

    expect(src).toContain('charset="UTF-8"')
    expect(src).toContain('name="viewport"')
    expect(src).toContain("width=device-width")
  })
})

describe("Dashboard component", () => {
  it("renders auth screen and dashboard containers", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Dashboard.tsx"),
      "utf-8",
    )

    expect(src).toContain('id="auth-screen"')
    expect(src).toContain('id="dashboard"')
  })

  it("has token input field", () => {
    const fs = require("fs")
    const path = require("path")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "views", "Dashboard.tsx"),
      "utf-8",
    )

    expect(src).toContain('id="token-input"')
  })
})

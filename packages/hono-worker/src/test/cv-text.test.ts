import { describe, it, expect } from "vitest"
import { zipSync, strToU8 } from "fflate"
import { extractCvText, CV_TEXT_LIMIT } from "../utils/cv-text"

/**
 * Unit tests for CV text extraction (PROJECT_PLAN §4.3 "Parse the CV once").
 * The DOCX path is fully exercisable in-process: a .docx IS a zip, so the
 * fixtures are built with fflate's zipSync. The PDF path needs a real PDF
 * (pdf.js) — covered indirectly by e2e upload tests, not here.
 */

function buildDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`
  return zipSync(
    { "word/document.xml": strToU8(xml) },
    { level: 0 },
  )
}

describe("extractCvText", () => {
  it("extracts paragraph text from a minimal DOCX", async () => {
    const bytes = buildDocx([
      "Senior TypeScript Engineer",
      "Acme Corp — 2021 to 2024",
      "Built things with React and Cloudflare Workers.",
    ])
    const text = await extractCvText(
      bytes.buffer as ArrayBuffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "cv.docx",
    )
    expect(text).toContain("Senior TypeScript Engineer")
    expect(text).toContain("Acme Corp — 2021 to 2024")
    // Paragraph breaks survive as newlines.
    expect(text?.split("\n").length).toBeGreaterThanOrEqual(3)
  })

  it("unescapes XML entities in DOCX text", async () => {
    const bytes = buildDocx(["AT&amp;T &lt;engineering&gt;"])
    const text = await extractCvText(bytes.buffer as ArrayBuffer, "", "cv.docx")
    expect(text).toContain("AT&T <engineering>")
  })

  it("returns null for unsupported formats", async () => {
    const text = await extractCvText(new ArrayBuffer(4), "image/png", "cv.png")
    expect(text).toBeNull()
  })

  it("returns null for legacy binary .doc", async () => {
    const text = await extractCvText(new ArrayBuffer(8), "", "cv.doc")
    expect(text).toBeNull()
  })

  it("returns null for a corrupt zip claimed as .docx", async () => {
    const junk = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4])
    const text = await extractCvText(junk.buffer as ArrayBuffer, "", "cv.docx")
    expect(text).toBeNull()
  })

  it("returns null when extracted text is empty", async () => {
    const bytes = buildDocx(["   "])
    const text = await extractCvText(bytes.buffer as ArrayBuffer, "", "cv.docx")
    expect(text).toBeNull()
  })

  it("caps extracted text at the limit", async () => {
    const huge = "x".repeat(CV_TEXT_LIMIT + 5000)
    const bytes = buildDocx([huge])
    const text = await extractCvText(bytes.buffer as ArrayBuffer, "", "cv.docx")
    expect(text?.length).toBe(CV_TEXT_LIMIT)
  })
})

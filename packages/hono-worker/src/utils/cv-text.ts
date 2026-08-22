// =============================================================================
// CV text extraction — turns uploaded CV bytes into the plain text the
// tailoring LLM actually reads (PROJECT_PLAN §4.3, "Parse the CV once").
// =============================================================================
// The LLM must see real CV content; the R2 pointer alone is useless to it.
// Extraction runs on upload (POST /api/profile/cv) and is best-effort:
// a failure returns null and leaves the upload intact — generation surfaces
// a clear 422-style error instead of silently degrading.
//
// Formats:
//   - PDF  → unpdf (serverless-friendly pdf.js build), lazily imported so
//            its bundle cost is paid only when a PDF is actually parsed.
//   - DOCX → fflate unzip of word/document.xml + <w:t> text extraction.
//            (Legacy binary .doc is not parseable without heavy deps —
//            returns null; the UI nudges the user to re-save as PDF/DOCX.)

import { unzipSync } from "fflate"

const MAX_CV_TEXT_CHARS = 100_000

/** Detect the CV format from content type + filename. */
function detectFormat(
  contentType: string,
  filename: string,
): "pdf" | "docx" | null {
  const ct = (contentType || "").toLowerCase()
  const name = (filename || "").toLowerCase()
  if (ct.includes("pdf") || name.endsWith(".pdf")) return "pdf"
  if (
    ct.includes("wordprocessingml") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  ) {
    // .doc (legacy binary) is not the same as .docx — only claim docx when
    // it's the OOXML format; the zip sniff below rejects binary .doc anyway.
    return name.endsWith(".doc") && !name.endsWith(".docx") ? null : "docx"
  }
  return null
}

async function extractPdf(bytes: Uint8Array): Promise<string | null> {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === "string" ? text : null
}

function extractDocx(bytes: Uint8Array): string | null {
  // A .docx is a ZIP; the document body lives in word/document.xml. Pull
  // every <w:t> text run, paragraph breaks from </w:p>, tabs from <w:tab/>.
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    return null // not a zip — e.g. legacy binary .doc
  }
  const xmlBytes = files["word/document.xml"]
  if (!xmlBytes) return null

  const xml = new TextDecoder().decode(xmlBytes)
  const text = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Extract CV text from uploaded bytes. Returns null when the format is
 * unsupported or parsing fails — callers treat that as "cvText unavailable"
 * (non-blocking) and surface it when generation is attempted.
 */
export async function extractCvText(
  bytes: ArrayBuffer,
  contentType: string,
  filename: string,
): Promise<string | null> {
  const format = detectFormat(contentType, filename)
  if (!format) return null

  try {
    const raw =
      format === "pdf"
        ? await extractPdf(new Uint8Array(bytes))
        : extractDocx(new Uint8Array(bytes))
    if (!raw) return null

    const cleaned = raw.replace(/\r\n/g, "\n").trim()
    if (cleaned.length === 0) return null

    return cleaned.slice(0, MAX_CV_TEXT_CHARS)
  } catch (e) {
    console.warn("[cv-text] extraction failed:", e)
    return null
  }
}

export const CV_TEXT_LIMIT = MAX_CV_TEXT_CHARS

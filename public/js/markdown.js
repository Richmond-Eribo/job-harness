// =========================================================================
// markdown.js — tiny, dependency-free markdown renderer (~3KB)
// =========================================================================
// WHY THIS EXISTS
// The harness emits LLM-generated text (summaries, findings, job notes, tool
// inputs/outputs). Dumping that as raw textContent makes `**bold**`, lists,
// and code fences render as literal characters and looks broken. Shipping a
// full markdown lib (marked.js ~30KB, markdown-it ~80KB) is overkill for what
// the dashboard actually shows; this handles the cases the model produces.
//
// SAFETY
// All input is HTML-escaped BEFORE any markdown transform runs. The only HTML
// in the output comes from this renderer. It is therefore safe to feed raw,
// untrusted LLM output (or tool output) to `md.render(...)` and inject via
// innerHTML — the model cannot inject <script> or onerror attributes, because
// any < > & in the source is escaped to entities before we ever look at it.
//
// SUPPORTS (curated to what the harness emits)
//   ### headings (h1–h4)
//   **bold**, _italic_, `inline code`
//   ```fenced code blocks```
//   - / * / 1. lists (nested via indentation)
//   > blockquotes
//   [text](url) and bare URLs
//   --- horizontal rule
//   paragraphs (split on blank lines)
//
// DOES NOT SUPPORT (intentionally)
//   tables, HTML passthrough, images, footnotes. None of these show up in the
//   harness output. If they ever do, swap this for marked.js.
// =========================================================================

(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }

  function inline(s) {
    // inline code first so its content isn't transformed by bold/italic
    const codeStash = []
    s = s.replace(/`([^`]+)`/g, function (_, code) {
      codeStash.push('<code class="md-code">' + escapeHtml(code) + "</code>")
      return "\x00CODE" + (codeStash.length - 1) + "\x00"
    })

    // escape what's left
    s = escapeHtml(s)

    // bold — **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>")

    // italic — *text* or _text_
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
    s = s.replace(/(^|[^_\w])_([^_]+)_/g, "$1<em>$2</em>")

    // links — [text](url). Only allow http(s) URLs.
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )

    // bare URLs (not already inside a link)
    s = s.replace(
      /(^|[\s(])((https?:\/\/)[^\s<)]+)(?![^<]*<\/a>)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    )

    // restore stashed code
    s = s.replace(/\x00CODE(\d+)\x00/g, function (_, i) {
      return codeStash[Number(i)]
    })

    return s
  }

  function render(src) {
    if (src == null) return ""
    src = String(src)

    // Normalize line endings, strip trailing whitespace.
    src = src.replace(/\r\n?/g, "\n").replace(/\s+$/g, "")

    if (src.trim() === "") return ""

    // Stash fenced code blocks so their content is never touched by inline
    // transforms or list/heading parsing.
    const codeBlocks = []
    src = src.replace(/```([\w-]*)\n?([\s\S]*?)```/g, function (_, lang, body) {
      const langClass = lang ? ' data-lang="' + escapeHtml(lang) + '"' : ""
      codeBlocks.push(
        '<pre class="md-pre"' +
          langClass +
          "><code>" +
          escapeHtml(body.replace(/\n$/, "")) +
          "</code></pre>",
      )
      return "\x00BLOCK" + (codeBlocks.length - 1) + "\x00"
    })

    const lines = src.split("\n")
    const out = []
    let i = 0

    // Current open list type, used to close lists before non-list lines.
    let listType = null // 'ul' | 'ol' | null
    function closeList() {
      if (listType) {
        out.push("</" + listType + ">")
        listType = null
      }
    }

    while (i < lines.length) {
      const raw = lines[i]

      // Restored fenced block — emit as-is, ends any open list
      const blockHit = raw.match(/^\x00BLOCK(\d+)\x00$/)
      if (blockHit) {
        closeList()
        out.push(codeBlocks[Number(blockHit[1])])
        i++
        continue
      }

      // Horizontal rule
      if (/^\s*---+\s*$/.test(raw)) {
        closeList()
        out.push('<hr class="md-hr">')
        i++
        continue
      }

      // Heading — only h1–h4, anything deeper is left as a paragraph
      const heading = raw.match(/^(#{1,4})\s+(.*)$/)
      if (heading) {
        closeList()
        const level = heading[1].length
        out.push("<h" + level + ' class="md-h md-h' + level + '">' + inline(heading[2]) + "</h" + level + ">")
        i++
        continue
      }

      // Blockquote — collapse consecutive lines
      if (/^\s*>\s?/.test(raw)) {
        closeList()
        const quoteLines = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""))
          i++
        }
        out.push(
          '<blockquote class="md-quote">' + inline(quoteLines.join(" ")) + "</blockquote>",
        )
        continue
      }

      // Unordered list item — -, *, +
      const ulItem = raw.match(/^\s{0,3}[-*+]\s+(.*)$/)
      if (ulItem) {
        if (listType !== "ul") {
          closeList()
          out.push('<ul class="md-ul">')
          listType = "ul"
        }
        out.push("<li>" + inline(ulItem[1]) + "</li>")
        i++
        continue
      }

      // Ordered list item — 1. 2. etc.
      const olItem = raw.match(/^\s{0,3}\d+\.\s+(.*)$/)
      if (olItem) {
        if (listType !== "ol") {
          closeList()
          out.push('<ol class="md-ol">')
          listType = "ol"
        }
        out.push("<li>" + inline(olItem[1]) + "</li>")
        i++
        continue
      }

      // Blank line — closes list, no output
      if (/^\s*$/.test(raw)) {
        closeList()
        i++
        continue
      }

      // Paragraph — collect consecutive lines that aren't any of the above
      closeList()
      const paraLines = []
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\x00BLOCK\d+\x00$/.test(lines[i]) &&
        !/^\s*---+\s*$/.test(lines[i]) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s{0,3}[-*+]\s+/.test(lines[i]) &&
        !/^\s{0,3}\d+\.\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i])
        i++
      }
      if (paraLines.length > 0) {
        out.push("<p>" + inline(paraLines.join("\n")).replace(/\n/g, "<br>") + "</p>")
      }
    }

    closeList()
    return out.join("\n")
  }

  global.md = { render: render, escapeHtml: escapeHtml }
})(window)

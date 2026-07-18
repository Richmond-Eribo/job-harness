// =========================================================================
// json.js — pretty-print + lightly syntax-highlight JSON in the dashboard
// =========================================================================
// Tool inputs and outputs are stored as JSON strings (the harness stores them
// in the step_log table; the dashboard's Activity Log shows them). The old UI
// dumped them as raw text, so the JSON was either one long unreadable line or
// a sliced-to-60-char snippet with no way to see the structure.
//
// renderJson(str, opts?) returns an HTML string that:
//   1. parses the string as JSON
//   2. pretty-prints with 2-space indentation
//   3. wraps each token kind in a span with a stable class for CSS colour
//   4. truncates to opts.maxChars (default 4000) and shows a "(truncated)"
//      marker rather than silently cut mid-token
//   5. falls back to escaped plain text in a <pre> when the input is not
//      valid JSON, so malformed tool output still renders cleanly
//
// SECURITY
// Output is produced by String.replace on an already-escaped string. No
// untrusted input is ever innerHTML'd directly. Safe to use with innerHTML.
// =========================================================================

(function (global) {
  var DEFAULT_MAX = 4000

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }

  // Try to parse a JSON string. Many tool outputs are JSON-stringified twice,
  // or have trailing prose. Be tolerant: find the first { or [ and the matching
  // last close, try to parse that slice; on success, re-stringify it pretty.
  function tryParseLoose(raw) {
    if (raw == null) return null
    var s = String(raw).trim()
    if (s === "") return null

    // Fast path: already valid JSON
    try {
      return JSON.parse(s)
    } catch (e) {}

    // Slow path: isolate the first balanced JSON object/array
    var start = s.search(/[[{]/)
    if (start === -1) return null
    var openCh = s.charAt(start)
    var closeCh = openCh === "{" ? "}" : "]"
    var depth = 0
    var inStr = false
    var esc = false
    var end = -1
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i)
      if (inStr) {
        if (esc) {
          esc = false
        } else if (ch === "\\") {
          esc = true
        } else if (ch === '"') {
          inStr = false
        }
        continue
      }
      if (ch === '"') {
        inStr = true
      } else if (ch === openCh) {
        depth++
      } else if (ch === closeCh) {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return null
    try {
      return JSON.parse(s.slice(start, end + 1))
    } catch (e2) {
      return null
    }
  }

  function highlight(pretty) {
    var esc = escapeHtml(pretty)
    return esc.replace(
      /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      function (m, _g, isKey) {
        if (/^"/.test(m)) {
          if (isKey) {
            return '<span class="tok-key">' + m + "</span>"
          }
          return '<span class="tok-str">' + m + "</span>"
        }
        if (m === "true" || m === "false") {
          return '<span class="tok-bool">' + m + "</span>"
        }
        if (m === "null") {
          return '<span class="tok-null">' + m + "</span>"
        }
        return '<span class="tok-num">' + m + "</span>"
      },
    )
  }

  function truncatedMarker(max) {
    return '<div class="json-truncated">truncated at ' + max + " chars</div>"
  }

  function renderJson(raw, opts) {
    opts = opts || {}
    var max = typeof opts.maxChars === "number" ? opts.maxChars : DEFAULT_MAX
    if (raw == null) {
      return '<span class="json-empty">-</span>'
    }

    var parsed = tryParseLoose(raw)
    if (parsed === null) {
      // Not JSON — fall back to escaped plain text in a <pre>.
      var text = String(raw)
      var truncated = false
      if (text.length > max) {
        text = text.slice(0, max)
        truncated = true
      }
      var html =
        '<pre class="json-pre json-fallback">' + escapeHtml(text) + "</pre>"
      if (truncated) {
        html += truncatedMarker(max)
      }
      return html
    }

    var pretty = JSON.stringify(parsed, null, 2)
    if (pretty.length <= max) {
      return '<pre class="json-pre">' + highlight(pretty) + "</pre>"
    }

    // Truncate at a token boundary so the highlighter sees balanced strings.
    var cut = pretty.slice(0, max).replace(/"[^"]*$/, "")
    return (
      '<pre class="json-pre">' +
      highlight(cut) +
      "</pre>" +
      truncatedMarker(max)
    )
  }

  global.renderJson = renderJson
  global.tryParseLooseJson = tryParseLoose
})(window)

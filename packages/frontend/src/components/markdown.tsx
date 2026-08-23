// ── Shared Markdown renderer (light-theme styles, no typography plugin) ────
// Extracted from JobDetailPage so the trace transcript can render model
// reasoning/text as markdown too. Keep styles in sync when editing.
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-foreground/90 space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: p => (
            <h1 {...p} className="text-xl font-bold tracking-tight pt-2" />
          ),
          h2: p => <h2 {...p} className="text-lg font-semibold pt-2" />,
          h3: p => <h3 {...p} className="text-base font-semibold pt-1" />,
          p: p => <p {...p} className="whitespace-pre-wrap" />,
          ul: p => <ul {...p} className="list-disc pl-5 space-y-1" />,
          ol: p => <ol {...p} className="list-decimal pl-5 space-y-1" />,
          li: p => <li {...p} className="leading-relaxed" />,
          a: p => (
            <a
              {...p}
              className="text-primary underline underline-offset-2"
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
          strong: p => <strong {...p} className="font-semibold text-foreground" />,
          code: p => (
            <code
              {...p}
              className="font-mono text-xs bg-muted rounded px-1 py-0.5"
            />
          ),
          blockquote: p => (
            <blockquote
              {...p}
              className="border-l-2 border-border pl-3 text-muted-foreground"
            />
          ),
          hr: () => <hr className="border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

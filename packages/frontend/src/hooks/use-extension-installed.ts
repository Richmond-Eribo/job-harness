import { useEffect, useState } from "react"

// Detects whether the browser extension is INSTALLED in this browser.
//
// The extension's detect.js content script (registered on <all_urls> but a
// no-op elsewhere) sets `document.documentElement.dataset.agentHarnessExt` on
// pages that declare <meta name="agent-harness-site"> — i.e. this dashboard.
// Presence means installed; it says nothing about pairing or connection
// (that's GET /api/browser/status).
//
// Chrome injects content scripts into already-open tabs when an extension is
// newly installed, so the marker appears without a reload in the normal
// install → pair flow. ReLOADING the extension during development does not
// re-inject — that case needs one dashboard refresh (the ConnectBrowserCard
// copy mentions it as a last resort).

export type ExtensionPresence = "checking" | "installed" | "missing"

export function useExtensionInstalled(pollMs = 2000): ExtensionPresence {
  const [presence, setPresence] = useState<ExtensionPresence>(() =>
    typeof document === "undefined"
      ? "checking"
      : document.documentElement.dataset.agentHarnessExt
        ? "installed"
        : "checking",
  )

  useEffect(() => {
    let cancelled = false
    const check = () => {
      if (cancelled) return
      const installed = !!document.documentElement.dataset.agentHarnessExt
      setPresence(prev =>
        installed && prev !== "installed" ? "installed" : prev,
      )
    }
    check()
    const id = setInterval(check, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [pollMs])

  return presence
}

// =============================================================================
// ConnectBrowserCard — the guided "connect your browser" funnel.
// =============================================================================
// One shared component for both surfaces that need it:
//   • Settings → Browser & Extension tab (SettingsPage)
//   • Onboarding step 3 "Connect browser" (OnboardingPage, autoGenerateCode)
//
// It closes the discovery gap that existed when the only install instruction
// was a sentence in the onboarding list: a user who logged in and saw a red
// "No browser" pill had NO in-app path from "your browser isn't connected" to
// "here's exactly how to fix that". The funnel is explicit about the three
// distinct states users were previously left to guess apart:
//
//   1. INSTALLED?  — detected client-side via the extension's detect.js
//                    content script (dataset.agentHarnessExt marker; see
//                    useExtensionInstalled). No server round-trip, works
//                    pre-pairing.
//   2. PAIRED?     — the code flow below (POST /api/browser/pair → popup
//                    redeems it for a refresh token).
//   3. CONNECTED?  — server-side relay state (useBrowserStatus, 15s poll);
//                    flips green within one poll of the popup pairing.
//
// The Install step renders per-deployment instructions driven by
// `distribution` in /api/browser/status (browser-config.json): "unpacked"
// shows the chrome://extensions walkthrough, "store" links the Chrome Web
// Store listing.

import { useEffect, useRef, useState } from "react"
import { Check, Chrome, Copy, MousePointerClick, Plug } from "lucide-react"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@agent-harness/ui"
import { toast } from "sonner"
import { API_URL } from "../lib/auth"
import {
  useBrowserStatus,
  useDisconnectBrowser,
  usePairExtension,
  useUnpairAllBrowsers,
} from "../hooks/queries"
import { useExtensionInstalled } from "../hooks/use-extension-installed"

export function ConnectBrowserCard({
  autoGenerateCode = false,
}: {
  /** Onboarding: mint the pairing code as soon as the extension is detected
   *  so the user is never stuck hunting for the generate button. */
  autoGenerateCode?: boolean
}) {
  const { data: status } = useBrowserStatus()
  const presence = useExtensionInstalled()
  const pair = usePairExtension()
  const disconnect = useDisconnectBrowser()
  const unpairAll = useUnpairAllBrowsers()

  const [pairing, setPairing] = useState<{
    code: string
    expiresAt: number
  } | null>(null)
  // Lets the user reveal the Pair step manually when detection can't see the
  // extension (e.g. dev-mode extension reload, where Chrome does not
  // re-inject content scripts into open tabs).
  const [forceRevealPair, setForceRevealPair] = useState(false)

  const connected = status?.target === "live" || status?.target === "managed"
  const distribution = status?.distribution

  // Re-tick every 10s so the code expiry countdown stays honest without a
  // rerender storm.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10000)
    return () => clearInterval(id)
  }, [])

  const handlePair = () => {
    pair.mutate(undefined, {
      onSuccess: data => {
        setPairing({
          code: data.code,
          expiresAt: Date.now() + data.expiresIn * 1000,
        })
      },
      onError: (e: { message?: string }) =>
        toast.error("Couldn't generate a pairing code", {
          description: e?.message,
        }),
    })
  }

  // Onboarding: auto-mint the code once the extension shows up.
  const autoFired = useRef(false)
  useEffect(() => {
    if (!autoGenerateCode || autoFired.current) return
    if (presence !== "installed" || connected || pairing || pair.isPending)
      return
    autoFired.current = true
    handlePair()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateCode, presence, connected, pairing, pair.isPending])

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => toast.success("Browser disconnected"),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't disconnect", { description: e?.message }),
    })
  }

  const handleUnpairAll = () => {
    unpairAll.mutate(undefined, {
      onSuccess: d =>
        toast.success(
          d.revoked > 0
            ? `Revoked ${d.revoked} paired browser${d.revoked === 1 ? "" : "s"}`
            : "No paired browsers to revoke",
        ),
      onError: (e: { message?: string }) =>
        toast.error("Couldn't revoke pairings", { description: e?.message }),
    })
  }

  if (connected) {
    return (
      <Card className="border-success/40 bg-success/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <span className="size-2 rounded-full bg-success" />
                {status?.target === "managed"
                  ? "Browser connected (managed)"
                  : "Browser connected (your Chrome)"}
              </CardTitle>
              {status?.live?.connectedAt && (
                <CardDescription className="text-xs mt-1">
                  Connected since{" "}
                  {new Date(status.live.connectedAt).toLocaleString()}
                  {status.live.userAgent ? ` · ${status.live.userAgent}` : ""}
                </CardDescription>
              )}
            </div>
            <Chrome className="size-5 text-muted-foreground shrink-0" />
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 pt-0">
          <Button
            onClick={handleDisconnect}
            disabled={disconnect.isPending}
            variant="outline"
            size="sm"
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
          <Button
            onClick={handleUnpairAll}
            disabled={unpairAll.isPending}
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            Forget all paired browsers
          </Button>
        </CardContent>
      </Card>
    )
  }

  const showPairStep = presence === "installed" || forceRevealPair

  return (
    <div className="flex flex-col gap-4">
      {/* ── Step 1 — Install ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <StepNumber n={1} done={presence === "installed"} />
            Install the extension
          </CardTitle>
          <CardDescription className="text-xs">
            The agent browses through your Chrome — with your logins, without
            your passwords ever leaving this browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {distribution?.mode === "store" && distribution.storeUrl ? (
            <div className="flex items-center gap-3">
              <Button asChild size="sm" variant="outline">
                <a href={distribution.storeUrl} target="_blank" rel="noreferrer">
                  <Chrome className="size-4 mr-1.5" />
                  Add to Chrome
                </a>
              </Button>
              <span className="text-xs text-muted-foreground">
                Opens the Chrome Web Store in a new tab.
              </span>
            </div>
          ) : (
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>
                Download / clone this project, then open{" "}
                <code className="font-mono text-foreground bg-muted px-1 rounded">
                  chrome://extensions
                </code>{" "}
                in Chrome.
              </li>
              <li>
                Turn on{" "}
                <span className="text-foreground font-medium">
                  Developer mode
                </span>{" "}
                (top-right toggle).
              </li>
              <li>
                Click{" "}
                <span className="text-foreground font-medium">
                  Load unpacked
                </span>{" "}
                and select the{" "}
                <code className="font-mono text-foreground bg-muted px-1 rounded">
                  extension/
                </code>{" "}
                folder from the repo.
                {distribution?.guideUrl && (
                  <>
                    {" "}
                    <a
                      href={distribution.guideUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-foreground"
                    >
                      Full guide
                    </a>
                  </>
                )}
              </li>
            </ol>
          )}

          <PresenceLine presence={presence} />
        </CardContent>
      </Card>

      {/* ── Step 2 — Pair ────────────────────────────────────────────── */}
      <Card className={showPairStep ? "" : "opacity-60"}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <StepNumber n={2} />
            Pair it with this dashboard
          </CardTitle>
          <CardDescription className="text-xs">
            Click the extension icon in your Chrome toolbar and enter these two
            values.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!showPairStep ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setForceRevealPair(true)}
            >
              I've installed it — continue to pairing
            </Button>
          ) : (
            <>
              <WorkerUrlField />

              {!pairing ? (
                <Button
                  onClick={handlePair}
                  disabled={pair.isPending}
                  size="sm"
                  className="self-start"
                >
                  {pair.isPending ? "Generating…" : "Generate pairing code"}
                </Button>
              ) : (
                <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col items-center gap-2">
                  <p className="text-xs text-muted-foreground">
                    Enter this code in the extension popup:
                  </p>
                  <p className="text-3xl font-mono font-bold tracking-[0.3em] text-primary">
                    {pairing.code}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Expires{" "}
                    {Math.max(
                      0,
                      Math.round((pairing.expiresAt - Date.now()) / 1000 / 60),
                    )}{" "}
                    min from now · single use
                  </p>
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <MousePointerClick className="size-3.5" />
                    Waiting for the extension to connect — this turns green
                    automatically.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPairing(null)}
                  >
                    Done
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Sub-pieces ─────────────────────────────────────────────────────────────

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`size-5 rounded-full grid place-items-center text-[11px] font-semibold shrink-0 ${
        done
          ? "bg-success/20 text-success"
          : "bg-primary/10 text-primary border border-primary/30"
      }`}
      aria-hidden
    >
      {done ? <Check className="size-3.5" /> : n}
    </span>
  )
}

function PresenceLine({ presence }: { presence: string }) {
  if (presence === "installed") {
    return (
      <p className="text-xs text-success flex items-center gap-1.5">
        <Check className="size-4" />
        Extension detected — continue to pairing below.
      </p>
    )
  }
  if (presence === "checking") {
    return (
      <p className="text-xs text-muted-foreground">
        Checking for the extension…
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      <Plug className="size-3.5 inline mr-1 -mt-0.5" />
      Not detected yet. Chrome picks it up automatically after installing — if
      it doesn't appear within a few seconds, refresh this page.
    </p>
  )
}

// The worker URL the popup asks for. Same origin when VITE_API_URL is unset;
// otherwise the API worker's origin (SSR-safe: API_URL is a build-time
// constant, window is only touched on the client).
function workerOrigin(): string {
  try {
    if (API_URL) return new URL(API_URL).origin
    if (typeof window !== "undefined") return window.location.origin
  } catch {
    // fall through
  }
  return ""
}

function WorkerUrlField() {
  const [copied, setCopied] = useState(false)
  const origin = workerOrigin()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy — please select and copy it manually")
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Worker URL
      </p>
      <div className="flex items-center gap-2">
        <code className="text-xs font-mono bg-muted/50 border border-border rounded-md px-2.5 py-1.5 truncate flex-1">
          {origin || "(this site's origin)"}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label="Copy the worker URL to the clipboard"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  )
}

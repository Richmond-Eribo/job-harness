// =============================================================================
// BrowserRelay — WebSocket bridge between the agent and a real browser.
// =============================================================================
// THE PROBLEM
// The current job-agent uses a single unauthenticated fetch() + HTMLRewriter.
// Login-walled sites (Indeed, LinkedIn, Glassdoor) defeat that three ways:
// bot-detection (TLS fingerprint), the login wall itself (no session cookies),
// and JS-rendered content (HTMLRewriter only sees initial HTML). The agent
// needs a REAL browser.
//
// WHAT THIS DO IS
// A single relay DO bridges agent CDP (Chrome DevTools Protocol) commands to
// whichever browser target is available:
//
//   • LIVE  — the user's real, logged-in Chrome, reached via a Chrome
//             extension that opens an OUTBOUND WebSocket to this DO (the
//             Worker can't reach a browser behind NAT; the browser reaches
//             us). This target reaches login-walled sites because the user
//             is already signed in. Free-tier compatible.
//   • MANAGED — Cloudflare's hosted Chromium via @cloudflare/playwright (the
//               optional BROWSER binding, paid plan). Always available, but
//               sessionless — cannot reach login-walled content.
//
// The agent never knows which target it's talking to. It calls sendCdp() /
// targetKind() / observe() / act() and this DO routes appropriately.
//
// WHY A DURABLE OBJECT
// The extension's WebSocket is a long-lived connection only a DO can hold
// open across requests (a Worker handler drops it on return). The relay also
// holds per-session state (which extension is connected, the active tab,
// pending CDP correlation map) that persists between agent calls.
//
// CREDENTIALS NEVER TOUCH THIS SYSTEM (see browser-config.json → safety).
// The agent assumes the user is already logged in via the LIVE target. The
// relay never stores or transmits credentials. observe() detects login walls
// and STOPS — it never attempts login itself.
// =============================================================================

// DurableObject is an ambient global from @cloudflare/workers-types (no import).
import { Agent, callable } from "agents"
import browserConfig from "../config/browser-config.json"
import type { Env } from "../types"
import { EXT_TOKEN_SUBPROTOCOL_PREFIX } from "../auth/extension-token"

// @cloudflare/playwright is an OPTIONAL dep (managed headless, paid plan).
// It's only imported when env.BROWSER is bound. To keep the free-tier build
// type-checking without the package installed, we type the dynamic import as
// any here rather than declaring a module shim (which tsc rejects for a
// module it can't resolve).

// -----------------------------------------------------------------------------
// Types — the JSON frames exchanged over the extension WebSocket.
// -----------------------------------------------------------------------------
// The extension speaks a tiny envelope protocol on its WS:
//   { t: "cdp", id, method, params? }   — agent → relay → extension (a CDP call)
//   { t: "cdp-res", id, result?, error? } — extension → relay → agent (the reply)
//   { t: "cdp-event", method, params }  — extension → relay (unsolicited CDP event)
//   { t: "hello", version, ua }         — extension → relay on connect
//   { t: "ping" } / { t: "pong" }       — heartbeat
//
// Each CDP call carries a numeric id; the relay matches cdp-res by id back to
// the pending Promise. This is the same correlation Puppeteer/Playwright use.

type CdpCall = {
  id: number
  method: string
  params?: unknown
}

type CdpResponse =
  | { id: number; result?: unknown; error?: { message: string; data?: unknown } }
  | { t: "cdp-event"; method: string; params?: unknown }

type Envelope = CdpCall &
  Partial<CdpResponse> & {
    t?: string
    version?: string
    ua?: string
  }

type TargetKind = "none" | "live" | "managed"

// -----------------------------------------------------------------------------
// BrowserRelay DO
// -----------------------------------------------------------------------------
// Extends the SDK's Agent (which extends DurableObject) so it's compatible with
// getAgentByName and gains WS hibernation. We don't use the chat/MCP features
// — this is a pure relay — but Agent is the base every DO in this project uses.

interface BrowserRelayState {
  initialized: boolean
}

export class BrowserRelay extends Agent<Env, BrowserRelayState> {
  initialState: BrowserRelayState = { initialized: false }

  /** The extension's live WebSocket connection (null when disconnected). */
  private liveWs: WebSocket | null = null
  /** Live connection metadata, surfaced to the dashboard. */
  private liveMeta: { connectedAt: string; ua: string | null } | null = null
  /** Pending CDP calls awaiting an extension reply, keyed by id. */
  private pending = new Map<
    number,
    {
      resolve: (r: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  /** The last seen CDP session/target id from the extension (best-effort). */
  private sessionId: string | null = null
  /** Last browser events received, for debugging + the status panel. */
  private lastEvents: Array<{ at: string; method: string }> = []
  /** Monotonic CDP id counter for calls this relay originates. */
  private cdpId = 1

  // -------------------------------------------------------------------------
  // HTTP fetch — handles the WebSocket upgrade from the extension.
  // -------------------------------------------------------------------------
  // The extension connects to wss://<worker>/browser/relay with an
  // `Upgrade: websocket` header. We accept it as a STANDARD (non-hibernating)
  // connection. Hibernation was tempting (lets the DO sleep between events)
  // but breaks target tracking: after hibernation the webSocket* handlers run
  // on an evicted/reconstructed `this`, so this.liveWs goes stale and
  // targetKind() falsely reports "none". A browser relay under active use
  // needs immediate, in-memory message handling, so we keep the connection
  // live for the DO's lifetime and wire event handlers directly on the socket.
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade")
    if (upgradeHeader !== "websocket") {
      // Non-WS request → return relay status (used by /api/browser/status).
      return new Response(JSON.stringify(this.statusSnapshot()), {
        headers: { "content-type": "application/json" },
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Standard accept (NOT acceptWebSocket/hibernation). The DO stays alive
    // holding this socket for as long as the extension is connected; the
    // keepAlive pattern in the agent loop covers active browsing windows.
    server.accept()

    // If a previous live socket exists, close it — one live target at a time.
    if (this.liveWs && this.liveWs.readyState === 1) {
      try {
        this.liveWs.close()
      } catch {
        // ignore
      }
    }
    this.liveWs = server
    this.liveMeta = {
      connectedAt: new Date().toISOString(),
      ua: request.headers.get("user-agent"),
    }
    this.lastEvents = []

    // Wire handlers directly on this socket. (Non-hibernating: these persist
    // for the connection's life, not reconstructed on wake.)
    server.addEventListener("message", (event: MessageEvent) => {
      this.handleLiveMessage(server, event.data)
    })
    server.addEventListener("close", () => {
      if (this.liveWs === server) {
        this.liveWs = null
        this.liveMeta = null
        this.sessionId = null
      }
      // Reject in-flight calls — the browser they were bound to is gone.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error("browser disconnected (ws close)"))
        this.pending.delete(id)
      }
    })
    server.addEventListener("error", () => {
      if (this.liveWs === server) this.liveWs = null
    })

    // Echo the offered WebSocket subprotocol back on the 101 response.
    // RFC 6455 §4.2.2: when a client offers Sec-WebSocket-Protocol, the
    // server's 101 response MUST echo exactly one of the offered values, or
    // the BROWSER aborts the handshake — onopen never fires, onclose fires
    // immediately, and targetKind() stays "none" forever. The extension
    // authenticates by offering `ja-ext-token.<jwt>` as the subprotocol; we
    // pick that one and echo it so the handshake completes. Without this,
    // liveWs was set then immediately nulled by the close handler.
    const offeredProtocols =
      request.headers.get("sec-websocket-protocol") ?? ""
    let selectedProtocol: string | null = null
    if (offeredProtocols) {
      for (const p of offeredProtocols.split(",").map(s => s.trim())) {
        if (p.startsWith(EXT_TOKEN_SUBPROTOCOL_PREFIX)) {
          selectedProtocol = p
          break
        }
      }
    }

    console.log(
      `[browser-relay] WS upgrade accepted — storing live target. ` +
        `echoedSubprotocol=${selectedProtocol ? "yes" : "no"} ` +
        `ua=${request.headers.get("user-agent") ?? "?"}`,
    )

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: selectedProtocol
        ? { "sec-websocket-protocol": selectedProtocol }
        : undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Live-socket message handler (non-hibernating). Mirrors the old
  // webSocketMessage body but runs via the addEventListener wiring above.
  // -------------------------------------------------------------------------
  private handleLiveMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    let env: Envelope
    try {
      env = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg))
    } catch {
      return // malformed frame — ignore
    }

    // Resolve a pending CDP call.
    if (env.t === "cdp-res" && typeof env.id === "number") {
      const p = this.pending.get(env.id)
      if (p) {
        this.pending.delete(env.id)
        clearTimeout(p.timer)
        if (env.error) {
          p.reject(
            Object.assign(new Error(env.error.message || "cdp error"), {
              data: env.error.data,
            }),
          )
        } else {
          p.resolve(env.result)
        }
      }
      return
    }

    // Unsolicited CDP event from the browser (e.g. Page.frameNavigated).
    if (env.t === "cdp-event") {
      this.lastEvents.unshift({
        at: new Date().toISOString(),
        method: env.method || "?",
      })
      if (this.lastEvents.length > 25) this.lastEvents.length = 25
      return
    }

    // Heartbeat.
    if (env.t === "ping") {
      this.safeSend(ws, { t: "pong" })
      return
    }
    if (env.t === "hello") {
      this.liveMeta = {
        connectedAt: this.liveMeta?.connectedAt ?? new Date().toISOString(),
        ua: env.ua ?? this.liveMeta?.ua ?? null,
      }
    }
  }

  // -------------------------------------------------------------------------
  // RPCs the BrowserAgent (and the dashboard status route) call.
  // -------------------------------------------------------------------------

  /** Which target is currently usable? */
  @callable()
  targetKind(): TargetKind {
    if (this.liveWs && this.liveWs.readyState === 1 /* OPEN */) return "live"
    if ((this.env as any).BROWSER) return "managed"
    return "none"
  }

  /**
   * Send a CDP command to the active browser target and await its response.
   * For the live target this round-trips through the extension WS; for the
   * managed target it calls into the playwright session (lazily created).
   * Rejects if no target is connected or the call times out.
   */
  @callable()
  async sendCdp(method: string, params?: unknown): Promise<unknown> {
    const target = this.targetKind()
    if (target === "none") {
      throw new Error(
        "No browser target connected. Install the extension and connect your Chrome, " +
          "or enable the managed BROWSER binding (paid plan).",
      )
    }
    if (target === "live") return this.sendCdpLive(method, params)
    return this.sendCdpManaged(method, params)
  }

  /** Live-target CDP call: enqueue on the extension WS + await the reply. */
  private sendCdpLive(method: string, params?: unknown): Promise<unknown> {
    const ws = this.liveWs
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error("live browser not connected"))
    }
    const id = this.cdpId++
    const call: Envelope = { t: "cdp", id, method, params }
    const timeoutMs: number =
      (browserConfig.relay as any)?.cdpCallTimeoutMs ?? 15000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`cdp call timed out after ${timeoutMs}ms: ${method}`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(call))
      } catch (e: any) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`failed to send cdp: ${e?.message ?? e}`))
      }
    })
  }

  /**
   * Managed-target CDP call via @cloudflare/playwright. Lazily created and
   * cached on the DO instance. This branch only runs if env.BROWSER is bound
   * (paid plan). The package is dynamically imported so the free-tier build
   * doesn't require it to be installed.
   */
  private managedSession: any = null
  private async sendCdpManaged(method: string, params?: unknown): Promise<unknown> {
    if (!this.managedSession) {
      try {
        // Dynamic import — @cloudflare/playwright is an optional dep (paid
        // plan). If the binding exists but the package isn't installed, this
        // throws a clear error the agent surfaces. @ts-ignore because the
        // package isn't present in the free-tier build.
        // @ts-ignore - optional dependency, may not be installed
        const pw: any = await import("@cloudflare/playwright")
        const browser = await pw.launch((this.env as any).BROWSER)
        this.managedSession = await browser.newSession()
      } catch (e: any) {
        throw new Error(
          `managed browser unavailable: ${e?.message ?? e}. ` +
            `Install @cloudflare/playwright and enable the BROWSER binding (paid plan), ` +
            `or connect the Chrome extension for the live target.`,
        )
      }
    }
    const s = this.managedSession
    if (!s) throw new Error("managed session not initialized")
    // @cloudflare/playwright sessions expose a CDP-ish send method.
    return await s.send(method, params)
  }

  /** Disconnect the live target (used by the dashboard "Disconnect" button). */
  @callable()
  disconnectLive(): boolean {
    if (this.liveWs) {
      try {
        this.liveWs.close()
      } catch {
        // ignore
      }
      this.liveWs = null
      this.liveMeta = null
      return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Status — surfaced to the dashboard's browser panel + /api/browser/status.
  // -------------------------------------------------------------------------
  @callable()
  statusSnapshot() {
    return {
      target: this.targetKind(),
      live: this.liveMeta
        ? {
            connected: true,
            connectedAt: this.liveMeta.connectedAt,
            userAgent: this.liveMeta.ua,
          }
        : { connected: false },
      managed: { available: !!(this.env as any).BROWSER },
      sessionId: this.sessionId,
      recentEvents: this.lastEvents.slice(0, 8),
      pendingCalls: this.pending.size,
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  private safeSend(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj))
    } catch {
      // connection may have closed; ignore
    }
  }
}

// -----------------------------------------------------------------------------
// BrowserAgent — runs the observe/act/extract LLM loop against a relay target.
// (Defined in browser-agent.ts; re-exported here so the barrel + env types can
// import both from one place.)
// -----------------------------------------------------------------------------
export type { BrowserAgent } from "./browser-agent"

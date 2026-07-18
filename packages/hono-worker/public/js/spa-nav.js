// ===========================================================================
// spa-nav.js — seamless client-side navigation on top of SSR pages.
//
// The server returns full HTML documents for every page. Instead of letting
// the browser do a hard navigation (which tears down the whole document and
// resets scroll), we intercept eligible link clicks, fetch the target URL,
// and swap ONLY the per-page `.main-scroll` region into the live document.
// The sidebar, topbar, status badge, modals and running polls all stay
// mounted, so there is no flash and the periodic refreshers keep working.
//
// Progressive enhancement: links remain real <a href>. If JS is disabled,
// a fetch fails, or the parsed doc has no `.main-scroll`, we fall back to a
// normal browser navigation. Loaded BEFORE dashboard.js so `navigate()` is
// available when dashboard.js boots.
// ===========================================================================
;(function () {
  "use strict"

  if (window.__spaNav) return
  window.__spaNav = true

  // We own scroll restoration: forward navigation goes to top, back/forward
  // restores the offset we stashed in history.state.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"

  const MAIN = ".main-scroll" // per-page scroll container in AppShell
  const SIDEBAR_ITEM = ".sb-item" // sidebar nav links
  let inflight = null // current navigate() promise, to drop stale responses

  // -- helpers -------------------------------------------------------------

  function abs(url) {
    // Resolve any URL against the document (handles relative + absolute).
    return new URL(url, location.href).toString()
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin
    } catch (_) {
      return false
    }
  }

  // The page content scroll target. Falls back to document.scrollingElement
  // for safety, but in this app it's always `.main-scroll`.
  function scrollEl() {
    return document.querySelector(MAIN) || document.scrollingElement || document.body
  }

  // Stash where the user currently is, so a later back/forward returns there.
  function rememberScroll(state) {
    const st = scrollEl()
    return Object.assign({}, state || {}, { scroll: st ? st.scrollTop : 0 })
  }

  // Move the sidebar's active highlight to the page that owns `path`.
  function setActiveSidebar(path) {
    const items = document.querySelectorAll(SIDEBAR_ITEM)
    let matchHref = null
    // Pick the best-matching href for this path (e.g. /traces/:id -> /traces).
    for (const it of items) {
      const href = it.getAttribute("href")
      if (!href) continue
      if (path === href || path.indexOf(href + "/") === 0) {
        matchHref = href
      }
    }
    for (const it of items) {
      const href = it.getAttribute("href")
      const on = href === matchHref || (matchHref === null && href === "/")
      it.setAttribute("aria-current", on ? "page" : "false")
      it.classList.toggle("sb-item-active", on)
    }
  }

  // Extract just the per-page region from a parsed document and splice it in.
  function swapMain(parsedDoc) {
    const incoming = parsedDoc.querySelector(MAIN)
    const live = document.querySelector(MAIN)
    if (!incoming || !live) return false
    live.innerHTML = incoming.innerHTML
    const t = parsedDoc.querySelector("title")
    if (t && t.textContent) document.title = t.textContent
    return true
  }

  // Core navigation. `replace` swaps history entry instead of pushing (used
  // for same-page refreshes / state patches).
  async function navigate(toUrl, { replace = false } = {}) {
    const url = abs(toUrl)
    if (!sameOrigin(url)) {
      window.location.href = url
      return
    }
    const target = new URL(url, location.href)
    // Hash-only change on the same path — let the browser handle it.
    if (
      target.pathname === location.pathname &&
      target.search === location.search &&
      target.hash
    ) {
      return
    }
    // Same URL, no hash — nothing to do.
    if (url === location.href && !replace) return

    // Save the scroll of the page we're leaving into its own history entry.
    try {
      history.replaceState(
        rememberScroll(history.state),
        "",
        location.href,
      )
    } catch (_) {}

    const myReq = Symbol()
    inflight = myReq
    try {
      const res = await fetch(url, {
        headers: { "X-Requested-With": "spa-nav" },
        credentials: "same-origin",
      })
      if (!res.ok) throw new Error("HTTP " + res.status)
      if (inflight !== myReq) return // a newer navigate() superseded us
      const html = await res.text()
      if (inflight !== myReq) return
      const parsed = new DOMParser().parseFromString(html, "text/html")
      if (!swapMain(parsed)) throw new Error("no main region")
      const path = target.pathname
      setActiveSidebar(path)
      const state = { url, scroll: replace ? scrollEl().scrollTop : 0 }
      if (replace) history.replaceState(state, "", url)
      else history.pushState(state, "", url)
      // Forward nav resets scroll to the top of the new page.
      if (!replace) {
        const st = scrollEl()
        if (st) st.scrollTop = 0
      }
      // Let dashboard.js hydrate the freshly swapped page and (re)wire polls.
      if (typeof window.onSpaNav === "function") {
        try {
          window.onSpaNav(path, target.search)
        } catch (_) {}
      }
    } catch (e) {
      if (inflight !== myReq) return
      // Any failure -> degrade gracefully to a hard navigation.
      window.location.href = url
    }
  }

  // Exposed globally so dashboard.js (notifications, trace rows) can use it.
  window.navigate = navigate

  // -- link click interception (bubble phase) ------------------------------
  // Bubble phase so per-element handlers like the job-card
  // `event.preventDefault(); openJobSheet()` run FIRST and can opt out.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target.closest && e.target.closest("a[href]")
    if (!a) return
    const href = a.getAttribute("href")
    if (!href || href.charAt(0) === "#") return // hash/anchor links
    if (a.getAttribute("target") === "_blank") return
    if (a.hasAttribute("download")) return
    if (!sameOrigin(a.href)) return // external
    // Only intercept document routes, never /api/* or the browser relay WS.
    const p = new URL(a.href, location.href)
    if (p.pathname.indexOf("/api/") === 0) return
    if (p.pathname === "/browser/relay") return
    // Same path + same query + no hash -> no-op nav (don't intercept either).
    e.preventDefault()
    navigate(a.href)
  })

  // -- back / forward ------------------------------------------------------
  window.addEventListener("popstate", function (e) {
    const url = location.href
    const want = (e.state && typeof e.state.scroll === "number")
      ? e.state.scroll
      : null
    const myReq = Symbol()
    inflight = myReq
    fetch(url, {
      headers: { "X-Requested-With": "spa-nav" },
      credentials: "same-origin",
    })
      .then(r => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then(html => {
        if (inflight !== myReq) return
        const parsed = new DOMParser().parseFromString(html, "text/html")
        if (!swapMain(parsed)) throw new Error("no main region")
        setActiveSidebar(location.pathname)
        if (typeof window.onSpaNav === "function") {
          try {
            window.onSpaNav(location.pathname, location.search)
          } catch (_) {}
        }
        const st = scrollEl()
        if (st && want != null) st.scrollTop = want
      })
      .catch(() => {
        // Can't recover softly -> hard load the URL.
        window.location.href = url
      })
  })
})()

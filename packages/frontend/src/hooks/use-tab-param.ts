import { parseAsStringEnum, useQueryState } from "nuqs"

// URL-backed tab state (nuqs). Every tab-like UI in the app MUST go through
// this hook — never useState, never raw useQueryState — so the nuqs/TanStack
// integration has exactly one seam.
//
// nuqs's TanStack Router adapter is official but EXPERIMENTAL and does not
// yet cover TanStack Start (our framework). If SSR hydration issues appear,
// swap the internals below to TanStack Router's native search params
// (useSearch + router.navigate with the route's validateSearch — already
// declared on every route that uses this hook) and leave all call sites
// untouched.
//
// Behavior: the selected tab lives in the URL (?tab=… / ?filter=…), so tabs
// survive refresh, are deep-linkable (/settings?tab=browser is linked from
// the ExtensionStatusPill and the Overview preflight checklist), and work
// with browser back/forward. Setting the fallback value clears the param
// (nuqs clearOnDefault), keeping default-view URLs clean. Invalid values
// parse to the fallback instead of throwing.

export function useTabParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [tab: T, setTab: (value: T) => void] {
  const [tab, setTab] = useQueryState(
    key,
    parseAsStringEnum([...allowed]).withDefault(fallback),
  )
  return [tab, (value: T) => void setTab(value)]
}

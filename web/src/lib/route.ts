import { useEffect, useState } from 'react'

export type Route = { view: string; param?: string; subParam?: string }

/** Views Shell can render AFTER the P4 IA restructure. Merged/folded pages own their old
 *  deep links via VIEW_REDIRECTS below; an unrouted hash is a 404 (Shell default branch). */
export const KNOWN_VIEWS = new Set([
  'home', 'org', 'orchestrator', 'projects', 'skills', 'runs', 'insights',
  'inbox', 'timeline', 'docs', 'verify', 'project', 'skill-creator', 'settings', 'lessons',
])

export function isKnownView(view: string): boolean {
  return KNOWN_VIEWS.has(view)
}

/** A legacy hash's raw Route → its canonical P4 Route. */
export type ViewRedirect = (r: Route) => Route

/** P4 IA restructure (E-29/E-10/E-30): every removed rail entry redirects to the page that
 *  absorbed it, deep-linked to the right segment/tab. Params flow through where the
 *  destination consumes them (workflow id → runs). */
export const VIEW_REDIRECTS: Record<string, ViewRedirect> = {
  chief: () => ({ view: 'org', param: 'tree' }),          // former Chief page content is the Tree segment
  orchestrators: () => ({ view: 'org', param: 'roster' }),
  graph: () => ({ view: 'org', param: 'graph' }),
  metrics: () => ({ view: 'insights', param: 'charts' }),
  routing: () => ({ view: 'insights', param: 'routing' }),
  evals: () => ({ view: 'insights', param: 'evals' }),
  workflows: (r) => (r.param ? { view: 'runs', param: r.param } : { view: 'runs', param: 'workflows' }),
  'workflow-detail': (r) => ({ view: 'runs', param: 'workflows', subParam: r.param }),
  memory: () => ({ view: 'inbox' }),
  terminal: () => ({ view: 'settings' }),
}

/** Apply a legacy-hash redirect if one exists; canonical routes pass through unchanged
 *  (idempotent — canonical view strings are never redirect keys). */
export function resolveRoute(raw: Route): Route {
  const redirect = VIEW_REDIRECTS[raw.view]
  return redirect ? redirect(raw) : raw
}

/** Parse a raw location.hash into a Route. Exported (pure) for testing; `parse`
 *  feeds it window.location.hash. A query suffix within the hash (#/metrics?foo=bar)
 *  is stripped BEFORE splitting so the view is 'metrics', not 'metrics?foo=bar' →
 *  NotFound (F-083). The query itself is ignored — no route consumes it today. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0]
  const segs = path.split('/').filter(Boolean)
  return { view: segs[0] || 'home', param: segs[1], subParam: segs[2] }
}

function parse(): Route {
  return parseHash(window.location.hash)
}

export function navigate(view: string, param?: string, subParam?: string, replace = false) {
  let hash = param ? `/${view}/${param}` : `/${view}`
  if (subParam) hash += `/${subParam}`
  // `replace` rewrites the current history entry instead of pushing a new one — used by the
  // legacy-hash redirect so a redirected URL leaves no spurious Back-button stop (a push there
  // would let Back return to the legacy hash, which re-redirects → a forward-bounce trap).
  if (replace) window.history.replaceState(null, '', `#${hash}`)
  else window.location.hash = hash
}

export function useHashRoute(): Route {
  const [raw, setRaw] = useState<Route>(parse)
  useEffect(() => {
    const onChange = () => setRaw(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const route = resolveRoute(raw)
  useEffect(() => {
    // If a legacy hash redirected, REPLACE the address bar with the canonical hash (no history
    // push → no Back-trap) and sync `raw` to canonical so a later revisit of the same legacy
    // hash re-fires this effect (replaceState alone fires no hashchange, so `raw` would go stale).
    if (VIEW_REDIRECTS[raw.view]) {
      navigate(route.view, route.param, route.subParam, true)
      setRaw(route)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw.view, raw.param, raw.subParam])
  return route
}

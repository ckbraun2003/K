import { useEffect, useState } from 'react'

export type Route = { view: string; param?: string; subParam?: string }

/** Views Shell can render. An unrouted hash (e.g. #/nonsense) is a 404 — see
 *  Shell's default branch and TopBar's title fallback. */
export const KNOWN_VIEWS = new Set([
  'home', 'chief', 'orchestrators', 'orchestrator', 'runs', 'docs', 'projects', 'metrics', 'routing',
  'verify', 'project', 'graph', 'skills', 'terminal', 'settings', 'workflows', 'workflow-detail', 'evals', 'memory',
  'skill-creator', 'inbox', 'timeline',
])

export function isKnownView(view: string): boolean {
  return KNOWN_VIEWS.has(view)
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

export function navigate(view: string, param?: string, subParam?: string) {
  let hash = param ? `/${view}/${param}` : `/${view}`
  if (subParam) hash += `/${subParam}`
  window.location.hash = hash
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const onChange = () => setRoute(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

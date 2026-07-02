import { useEffect, useState } from 'react'

export type Route = { view: string; param?: string; subParam?: string }

/** Views Shell can render. An unrouted hash (e.g. #/nonsense) is a 404 — see
 *  Shell's default branch and TopBar's title fallback. */
export const KNOWN_VIEWS = new Set([
  'home', 'chief', 'orchestrators', 'orchestrator', 'runs', 'docs', 'projects', 'metrics', 'routing',
  'verify', 'project', 'graph', 'skills', 'terminal', 'settings', 'workflows', 'workflow-detail', 'evals', 'memory',
])

export function isKnownView(view: string): boolean {
  return KNOWN_VIEWS.has(view)
}

function parse(): Route {
  const segs = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { view: segs[0] || 'home', param: segs[1], subParam: segs[2] }
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

import { useEffect, useState } from 'react'

export type Route = { view: string; param?: string }

function parse(): Route {
  const segs = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { view: segs[0] || 'home', param: segs[1] }
}

export function navigate(view: string, param?: string) {
  window.location.hash = param ? `/${view}/${param}` : `/${view}`
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

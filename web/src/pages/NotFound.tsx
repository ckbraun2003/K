import { useEffect } from 'react'
import { navigate } from '../lib/route'
import { Button } from '../ui/Button'

/** 404 empty-state for an unrouted hash (e.g. #/nonsense). Prefer an informative
 *  not-found over a silent redirect so the user knows where they ended up. */
export default function NotFound({ route }: { route: string }) {
  // Reflect the not-found state in the tab title while mounted; restore on unmount.
  useEffect(() => {
    const prev = document.title
    document.title = 'Not found — K'
    return () => { document.title = prev }
  }, [])

  return (
    <div
      data-testid="route-404"
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
      aria-live="polite"
    >
      <div className="mono text-display text-muted opacity-60">404</div>
      <h2 className="text-title text-text">Page not found</h2>
      <p className="text-body text-muted">
        Nothing is routed at <code className="mono text-text">#/{route}</code>.
      </p>
      <Button variant="glass" icon="home" onClick={() => navigate('home')}>
        Back to Home
      </Button>
    </div>
  )
}

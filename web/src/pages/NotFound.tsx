import { useEffect } from 'react'
import { navigate } from '../lib/route'

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
      <div className="text-4xl opacity-60">⌀</div>
      <h2 className="text-lg font-semibold text-[var(--text)]">Page not found</h2>
      <p className="text-sm text-[var(--muted)]">
        Nothing is routed at <code className="mono text-[var(--text)]">#/{route}</code>.
      </p>
      <button
        onClick={() => navigate('home')}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-sm text-[var(--text)] transition-colors duration-150 hover:border-accent/50 hover:bg-[var(--raised)]"
      >
        ⌂ Back to Home
      </button>
    </div>
  )
}

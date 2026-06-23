import { DESTINATIONS } from './Sidebar'
import { isKnownView } from '../lib/route'

interface Props {
  view: string
  connected: boolean
  onOpenCommand: () => void
}

export default function TopBar({ view, connected, onOpenCommand }: Props) {
  const dest = DESTINATIONS.find(d => d.id === view)
  // An unrouted hash must not masquerade as Home — surface the not-found state.
  const title = dest?.label.split(' ·')[0] ?? (isKnownView(view) ? 'Home' : 'Not found')
  const icon = dest?.icon ?? (isKnownView(view) ? '⌂' : '⌀')
  return (
    <header className="relative z-10 flex items-center gap-4 border-b border-[var(--border)] px-4 py-2.5">
      <h1 className="text-sm font-semibold tracking-wide text-[var(--text)]">
        <span className="mr-2 text-[var(--accent)]">{icon}</span>
        {title}
      </h1>
      <button
        onClick={onOpenCommand}
        className="ml-auto flex w-80 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-left text-xs text-[var(--muted)] transition-colors duration-150 hover:border-accent/50 hover:text-[var(--text)]"
      >
        <kbd className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        <span>Ask K or jump anywhere…</span>
      </button>
      <span
        data-testid="ws-dot"
        data-ws-status={connected ? 'connected' : 'connecting'}
        title={connected ? 'core connected' : 'connecting…'}
        className={`h-2 w-2 rounded-full ${connected ? 'bg-[var(--green)] glow-live' : 'bg-[var(--amber)] animate-pulse'}`}
      />
    </header>
  )
}

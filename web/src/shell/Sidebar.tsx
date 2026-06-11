import { cn } from '../lib/cn'
import { navigate } from '../lib/route'

export interface Destination {
  id: string
  icon: string
  label: string
  enabled: boolean
}

export const DESTINATIONS: Destination[] = [
  { id: 'home', icon: '⌂', label: 'Home', enabled: true },
  { id: 'projects', icon: '▦', label: 'Projects', enabled: true },
  { id: 'graph', icon: '◉', label: 'Fleet Graph · Phase 2', enabled: false },
  { id: 'runs', icon: '▶', label: 'Runs', enabled: true },
  { id: 'tasks', icon: '✓', label: 'Tasks · Phase 1', enabled: false },
  { id: 'skills', icon: '⚒', label: 'Skills · Phase 3', enabled: false },
  { id: 'metrics', icon: '∿', label: 'Metrics · Phase 1', enabled: false },
  { id: 'docs', icon: '▤', label: 'Docs', enabled: true },
]

export default function Sidebar({ active }: { active: string }) {
  return (
    <nav className="relative row-span-3 flex flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--surface)] py-3 z-10">
      <div className="mb-3 text-lg font-bold text-[var(--accent)]" title="Jarvis">⚡</div>
      {DESTINATIONS.map(d => (
        <button
          key={d.id}
          title={d.label}
          disabled={!d.enabled}
          aria-current={active === d.id ? 'page' : undefined}
          onClick={() => navigate(d.id)}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg text-base transition-colors duration-150',
            d.enabled ? 'text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]' : 'cursor-default text-[var(--border)]',
            active === d.id && 'bg-accent/20 text-[var(--accent-hover)]'
          )}
        >
          {d.icon}
        </button>
      ))}
      <button
        title="Settings · Phase 1"
        disabled
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-base text-[var(--border)]"
      >
        ⚙
      </button>
    </nav>
  )
}

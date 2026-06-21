import { cn } from '../lib/cn'
import { navigate } from '../lib/route'

export interface Destination {
  id: string
  icon: string
  label: string
  /** One-line description shown in the hover/focus tooltip for the icon-only nav. */
  hint: string
  enabled: boolean
}

export const DESTINATIONS: Destination[] = [
  { id: 'home', icon: '⌂', label: 'Home', hint: 'Fleet overview, metrics & getting started', enabled: true },
  { id: 'projects', icon: '▦', label: 'Projects', hint: 'Register & manage your projects', enabled: true },
  { id: 'graph', icon: '◉', label: 'Fleet Graph', hint: 'Visualize every project by health', enabled: true },
  { id: 'runs', icon: '▶', label: 'Runs', hint: 'Live & past agent runs', enabled: true },
  { id: 'tasks', icon: '✓', label: 'Tasks · Phase 1', hint: 'Per-project tasks (in project workspace)', enabled: false },
  { id: 'skills', icon: '⚒', label: 'Skills', hint: 'Author & trigger reusable skills', enabled: true },
  { id: 'metrics', icon: '∿', label: 'Metrics', hint: 'Tokens, cost & run trends', enabled: true },
  { id: 'routing', icon: '⇄', label: 'Routing', hint: 'Model routing stats', enabled: true },
  { id: 'terminal', icon: '>_', label: 'Terminal', hint: 'Embedded shell', enabled: true },
  { id: 'docs', icon: '▤', label: 'Docs', hint: 'Bible & artifacts', enabled: true },
]

export default function Sidebar({ active }: { active: string }) {
  return (
    <nav className="relative row-span-3 flex flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--surface)] py-3 z-10">
      <div className="mb-3 text-lg font-bold text-[var(--accent)]" title="K">⚡</div>
      {DESTINATIONS.map(d => (
        <button
          key={d.id}
          title={d.enabled ? `${d.label} — ${d.hint}` : d.label}
          aria-label={d.label}
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
        aria-label="Settings"
        disabled
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-base text-[var(--border)]"
      >
        ⚙
      </button>
    </nav>
  )
}

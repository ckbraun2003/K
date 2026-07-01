import { cn } from '../lib/cn'
import { navigate } from '../lib/route'

export interface Destination {
  id: string
  icon: string
  label: string
  /** One-line description shown in the hover/focus tooltip. */
  hint: string
  enabled: boolean
  /** Optional explicit navigation target. Defaults to `id`. Lets an entry (e.g. Help)
   *  deep-link into another view with a param without owning its own route. */
  view?: string
  param?: string
  /** Where the entry renders: the primary nav group, the footer cluster, or `hidden`
   *  (kept only so TopBar/⌘K can resolve a label for a view reached indirectly, e.g.
   *  the Docs view reached via Help — Docs is no longer a top-level destination). */
  section: 'primary' | 'footer' | 'hidden'
}

export const DESTINATIONS: Destination[] = [
  { id: 'home', icon: '⌂', label: 'Home', hint: 'Fleet overview, metrics & getting started', enabled: true, section: 'primary' },
  { id: 'projects', icon: '▦', label: 'Projects', hint: 'Register & manage your projects', enabled: true, section: 'primary' },
  { id: 'graph', icon: '◉', label: 'Fleet Graph', hint: 'Visualize every project by health', enabled: true, section: 'primary' },
  { id: 'runs', icon: '▶', label: 'Runs', hint: 'Live & past agent runs', enabled: true, section: 'primary' },
  { id: 'workflows', icon: '⋔', label: 'Workflows', hint: 'Delegation workflow & live sub-agent trees', enabled: true, section: 'primary' },
  { id: 'skills', icon: '⚒', label: 'Skills', hint: 'Author & trigger reusable skills', enabled: true, section: 'primary' },
  { id: 'metrics', icon: '∿', label: 'Metrics', hint: 'Tokens, cost & run trends', enabled: true, section: 'primary' },
  { id: 'routing', icon: '⇄', label: 'Routing', hint: 'Model routing stats', enabled: true, section: 'primary' },
  { id: 'evals', icon: '⊨', label: 'Evals', hint: 'Agent & skill behavioral evals + baselines', enabled: true, section: 'primary' },
  { id: 'memory', icon: '❋', label: 'Memory', hint: 'Review & approve proposed agent lessons', enabled: true, section: 'primary' },
  { id: 'terminal', icon: '>_', label: 'Terminal', hint: 'Embedded shell', enabled: true, section: 'primary' },
  // Footer cluster — secondary, lives below the spacer.
  { id: 'help', icon: '❔', label: 'Help', hint: 'How to use K — the user guide', enabled: true, view: 'docs', param: 'project-bible', section: 'footer' },
  { id: 'settings', icon: '⚙', label: 'Settings', hint: 'Provider/auth status & global system prompt', enabled: true, section: 'footer' },
  // Hidden: not a top-level destination (artifacts live in each project now), but kept
  // so TopBar/⌘K can resolve the "Docs" label for the view Help deep-links into.
  { id: 'docs', icon: '▤', label: 'Docs', hint: 'Harness bible & artifacts', enabled: true, view: 'docs', param: 'project-bible', section: 'hidden' },
]

/** Destinations reachable from ⌘K — everything enabled and not `hidden`. */
export const NAV_DESTINATIONS = DESTINATIONS.filter(d => d.enabled && d.section !== 'hidden')

export default function Sidebar({
  active,
  collapsed,
  onToggleCollapse,
}: {
  active: string
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const primary = DESTINATIONS.filter(d => d.section === 'primary')
  const footer = DESTINATIONS.filter(d => d.section === 'footer')

  const renderButton = (d: Destination) => {
    const target = d.view ?? d.id
    const isActive = active === target
    return (
      <button
        key={d.id}
        title={d.enabled ? `${d.label} — ${d.hint}` : d.label}
        aria-label={d.label}
        disabled={!d.enabled}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => navigate(target, d.param)}
        className={cn(
          'group flex h-10 items-center gap-3 rounded-control border border-transparent text-sm transition-all duration-150',
          collapsed ? 'w-10 justify-center px-0' : 'w-full px-3',
          d.enabled
            ? 'text-[var(--muted)] hover:border-[color:rgba(56,189,248,0.35)] hover:bg-[var(--raised)] hover:text-[var(--text)]'
            : 'cursor-default text-[color:rgba(169,155,196,0.4)]',
          isActive &&
            'border-[color:rgba(255,143,192,0.3)] bg-[color:rgba(255,143,192,0.14)] text-[var(--text)]'
        )}
      >
        <span
          className={cn(
            'w-5 shrink-0 text-center text-base transition-colors',
            isActive ? 'text-[var(--accent-hover)]' : 'group-hover:text-[var(--accent-hover)]'
          )}
        >
          {d.icon}
        </span>
        {!collapsed && <span className="truncate">{d.label}</span>}
      </button>
    )
  }

  return (
    <nav
      className={cn(
        'relative row-span-3 z-10 flex flex-col gap-1 border-r border-[var(--border)] bg-[var(--surface)] py-3 transition-[width] duration-200',
        collapsed ? 'items-center px-2' : 'px-2.5'
      )}
    >
      <div
        className={cn(
          'mb-3 flex items-center',
          collapsed ? 'justify-center' : 'justify-between px-1'
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-[var(--accent)]" title="K">⚡</span>
          {!collapsed && <span className="text-sm font-semibold tracking-[0.18em] text-[var(--text)]">K</span>}
        </div>
        {!collapsed && (
          <button
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            aria-expanded={true}
            title="Collapse sidebar"
            className="flex h-7 w-7 items-center justify-center rounded-control text-[var(--muted)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--accent-hover)]"
          >
            «
          </button>
        )}
      </div>

      {primary.map(renderButton)}

      <div className="flex-1" />

      {collapsed && (
        <button
          onClick={onToggleCollapse}
          aria-label="Expand sidebar"
          aria-expanded={false}
          title="Expand sidebar"
          className="mb-1 flex h-9 w-10 items-center justify-center rounded-control text-[var(--muted)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--accent-hover)]"
        >
          »
        </button>
      )}
      {footer.map(renderButton)}
    </nav>
  )
}

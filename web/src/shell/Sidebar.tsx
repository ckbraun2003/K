import { useQuery } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { RUNS_LIST_KEY, runsListQueryFn } from '../lib/runs-query'

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
  /** Which primary sub-group the entry renders under (D-024/D-026): `direct` = talk to
   *  / drive the org, `observe` = read-only telemetry. Only meaningful for `primary`
   *  entries; footer/hidden leave it undefined. Orthogonal to `section` (which stays
   *  the source of truth for NAV_DESTINATIONS, TopBar, and the chords invariant). */
  group?: 'direct' | 'observe'
}

export const DESTINATIONS: Destination[] = [
  // ── Direct: talk to / drive the org ──
  { id: 'home', icon: '⌂', label: 'K', hint: 'Talk to K — your front door to the org', enabled: true, section: 'primary', group: 'direct' },
  { id: 'chief', icon: '♛', label: 'Chief', hint: 'Org overview — objectives & delegation tree', enabled: true, section: 'primary', group: 'direct' },
  { id: 'orchestrators', icon: '❖', label: 'Orchestrators', hint: 'Domain leads — roster, charters & authority', enabled: true, section: 'primary', group: 'direct' },
  { id: 'workflows', icon: '⋔', label: 'Workflows', hint: 'Delegation workflow & live sub-agent trees', enabled: true, section: 'primary', group: 'direct' },
  { id: 'projects', icon: '▦', label: 'Projects', hint: 'Register & manage your projects', enabled: true, section: 'primary', group: 'direct' },
  { id: 'skills', icon: '⚒', label: 'Skills', hint: 'Author & trigger reusable skills', enabled: true, section: 'primary', group: 'direct' },
  { id: 'memory', icon: '❋', label: 'Memory', hint: 'Review & approve proposed agent lessons', enabled: true, section: 'primary', group: 'direct' },
  // ── Observe: read-only telemetry ──
  { id: 'runs', icon: '▶', label: 'Runs', hint: 'Live & past agent runs', enabled: true, section: 'primary', group: 'observe' },
  { id: 'graph', icon: '◉', label: 'Fleet Graph', hint: 'Visualize every project by health', enabled: true, section: 'primary', group: 'observe' },
  { id: 'metrics', icon: '∿', label: 'Metrics', hint: 'Tokens, cost & run trends', enabled: true, section: 'primary', group: 'observe' },
  { id: 'routing', icon: '⇄', label: 'Routing', hint: 'Model routing stats', enabled: true, section: 'primary', group: 'observe' },
  { id: 'evals', icon: '⊨', label: 'Evals', hint: 'Agent & skill behavioral evals + baselines', enabled: true, section: 'primary', group: 'observe' },
  { id: 'terminal', icon: '>_', label: 'Terminal', hint: 'Embedded shell', enabled: true, section: 'primary', group: 'observe' },
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
  const direct = primary.filter(d => d.group === 'direct')
  const observe = primary.filter(d => d.group === 'observe')
  const footer = DESTINATIONS.filter(d => d.section === 'footer')

  // Active-runs count for the Runs badge — the SAME shared default-list key/fn
  // ActivityStrip's live query uses (runs-query.ts), so this adds zero fetches;
  // the predicate matches ActivityStrip's "active" definition.
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn })
  const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'queued').length

  // Uppercase tracked group label — only rendered when the rail is expanded.
  const groupLabel = (text: string) => (
    <div className="mb-0.5 mt-1 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
      {text}
    </div>
  )

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
        {!collapsed && d.id === 'runs' && activeRuns > 0 && (
          <span
            data-testid="sidebar-runs-badge"
            className="ml-auto rounded bg-[var(--raised)] px-1.5 text-[10px] font-semibold text-[var(--accent-hover)]"
          >
            {activeRuns}
          </span>
        )}
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
      {/* The expand/collapse toggle stays in the header in BOTH states (F-011) —
          collapsed stacks it under the logo, expanded sits it to the right — so
          it never jumps to a different spot in the rail between states. */}
      <div
        className={cn(
          'mb-3 flex',
          collapsed ? 'flex-col items-center gap-2' : 'items-center justify-between px-1'
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-[var(--accent)]" title="K">⚡</span>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="text-sm font-semibold tracking-[0.18em] text-[var(--text)]">K</span>
              <span className="text-[10px] tracking-wide text-[var(--muted)]">agentic org</span>
            </div>
          )}
        </div>
        <button
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-7 w-7 items-center justify-center rounded-control text-[var(--muted)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--accent-hover)]"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {/* Direct — talk to / drive the org. */}
      {!collapsed && groupLabel('Direct')}
      {direct.map(renderButton)}

      {/* Observe — read-only telemetry. Collapsed: a hairline divider stands in for
          the group label so the two clusters stay visually distinct in the rail. */}
      {collapsed ? (
        <div className="my-1.5 h-px w-6 self-center bg-[var(--border)]" aria-hidden />
      ) : (
        groupLabel('Observe')
      )}
      {observe.map(renderButton)}

      <div className="flex-1" />

      {footer.map(renderButton)}
    </nav>
  )
}

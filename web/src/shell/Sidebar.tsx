import { useQuery } from '@tanstack/react-query'
import type { Run, InboxPayload } from '@k/shared'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { RUNS_LIST_KEY, runsListQueryFn, isActiveRun, isParkedRun } from '../lib/runs-query'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'

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
  { id: 'home', icon: '⌂', label: 'K', hint: 'Talk to K — your front door to the org', enabled: true, section: 'primary' },
  { id: 'org', icon: '♛', label: 'Org', hint: 'Chief, orchestrators & fleet — roster, tree & graph', enabled: true, section: 'primary' },
  { id: 'projects', icon: '▦', label: 'Projects', hint: 'Register & manage your projects', enabled: true, section: 'primary' },
  { id: 'skills', icon: '⚒', label: 'Skills', hint: 'Skills, MCP & hooks — the capability catalog', enabled: true, section: 'primary' },
  { id: 'runs', icon: '▶', label: 'Runs', hint: 'Live & past agent runs, delegation workflows', enabled: true, section: 'primary' },
  { id: 'insights', icon: '∿', label: 'Insights', hint: 'Overview, charts, routing & evals', enabled: true, section: 'primary' },
  { id: 'inbox', icon: '☑', label: 'Inbox', hint: 'Everything waiting on you — approve, reply, review', enabled: true, section: 'primary' },
  // Footer cluster — below the spacer.
  { id: 'help', icon: '❔', label: 'Help', hint: 'How to use K — the user guide', enabled: true, view: 'docs', param: 'project-bible', section: 'footer' },
  { id: 'settings', icon: '⚙', label: 'Settings', hint: 'Provider/auth status, diagnostics & global system prompt', enabled: true, section: 'footer' },
  // Hidden: not rail destinations, kept so TopBar/command-palette resolve a label for indirectly-reached views.
  { id: 'docs', icon: '▤', label: 'Docs', hint: 'Harness bible & artifacts', enabled: true, view: 'docs', param: 'project-bible', section: 'hidden' },
  { id: 'skill-creator', icon: '✎', label: 'Skill Creator', hint: 'Draft, refine & evaluate a skill with an agent', enabled: true, section: 'hidden' },
  // Demoted from the rail: reachable via command palette only. Memory folded its approvals into Inbox.
  { id: 'lessons', icon: '❋', label: 'Memory', hint: 'Review & approve proposed agent lessons', enabled: true, view: 'lessons', section: 'hidden' },
  { id: 'terminal', icon: '>_', label: 'Terminal', hint: 'Embedded shell (also in project workspace & Settings diagnostics)', enabled: true, section: 'hidden' },
]

/** Command-palette source: the enabled rail items PLUS the two deliberately-demoted
 *  deep-links (Memory->lessons, Terminal) which are reachable via the palette only. */
const COMMAND_ONLY = new Set(['lessons', 'terminal'])
export const NAV_DESTINATIONS = DESTINATIONS.filter(d => d.enabled && (d.section !== 'hidden' || COMMAND_ONLY.has(d.id)))

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

  // Runs-badge counts from the SAME shared default-list key/fn ActivityStrip's
  // live query uses (runs-query.ts), so this adds zero fetches; the predicates
  // match ActivityStrip's definitions. Parked (awaiting_input) runs count too —
  // an empty badge next to a run needing input hid it entirely (F-055).
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn })
  const activeRuns = runs.filter(isActiveRun).length
  const parkedRuns = runs.filter(isParkedRun).length
  const badgeCount = activeRuns + parkedRuns

  // Inbox needs-YOU badge — shares the ONE inbox query (lib/inbox-query.ts) with
  // the page + invalidators, so this adds zero fetches (the Runs-badge pattern).
  const { data: inbox } = useQuery<InboxPayload>({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const inboxCount = inbox?.total ?? 0

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
        {!collapsed && d.id === 'inbox' && inboxCount > 0 && (
          <span
            data-testid="sidebar-inbox-badge"
            title={`${inboxCount} item${inboxCount > 1 ? 's' : ''} waiting on you`}
            className="ml-auto rounded px-1.5 text-[10px] font-semibold bg-amber/20 text-[var(--amber)]"
          >
            {inboxCount}
          </span>
        )}
        {!collapsed && d.id === 'runs' && badgeCount > 0 && (
          <span
            data-testid="sidebar-runs-badge"
            title={parkedRuns > 0 ? `${parkedRuns} run${parkedRuns > 1 ? 's' : ''} awaiting your input` : undefined}
            className={cn(
              'ml-auto rounded px-1.5 text-[10px] font-semibold',
              // Amber = attention: at least one run is parked awaiting input.
              parkedRuns > 0
                ? 'bg-amber/20 text-[var(--amber)]'
                : 'bg-[var(--raised)] text-[var(--accent-hover)]',
            )}
          >
            {badgeCount}
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

      {primary.map(renderButton)}

      <div className="flex-1" />

      {footer.map(renderButton)}
    </nav>
  )
}

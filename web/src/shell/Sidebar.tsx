import { useQuery } from '@tanstack/react-query'
import type { Run, InboxPayload } from '@k/shared'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { openHelp } from '../lib/help-bus'
import { RUNS_LIST_KEY, runsListQueryFn, isActiveRun, isParkedRun } from '../lib/runs-query'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'
import { Icon, type IconName } from '../ui/Icon'

export interface Destination {
  id: string
  icon: IconName
  label: string
  /** One-line description shown in the hover/focus tooltip. */
  hint: string
  enabled: boolean
  /** Optional explicit navigation target. Defaults to `id`. Lets an entry
   *  deep-link into another view with a param without owning its own route. */
  view?: string
  param?: string
  /** Where the entry renders: the primary nav group, the footer cluster, or `hidden`
   *  (kept only so TopBar can resolve a label for a view reached indirectly). Help is
   *  in `footer` but opens the HelpGuide dialog (FE-6), not a route — see renderButton. */
  section: 'primary' | 'footer' | 'hidden'
}

// UI Simplification Task 10 — the 6-rail IA: Home/Personal/Agents/Runs/Insights/
// Projects replace the prior 7-primary/2-footer/5-hidden 14-item rail. Personal
// absorbs the Inbox; Agents absorbs Org + Skills + Runs' workflows sub-tab.
export const DESTINATIONS: Destination[] = [
  { id: 'home', icon: 'home', label: 'K', hint: 'Home — chat with K & your overview', enabled: true, section: 'primary' },
  { id: 'personal', icon: 'personal', label: 'Personal', hint: 'Your inbox, tasks, chats & memories', enabled: true, section: 'primary' },
  { id: 'agents', icon: 'agents', label: 'Agents', hint: 'Org, skills & pipelines — the agent organization', enabled: true, section: 'primary' },
  { id: 'runs', icon: 'runs', label: 'Runs', hint: 'Live & past agent runs', enabled: true, section: 'primary' },
  { id: 'insights', icon: 'insights', label: 'Insights', hint: 'Overview, charts, routing & evals', enabled: true, section: 'primary' },
  { id: 'projects', icon: 'projects', label: 'Projects', hint: 'Register & manage your projects', enabled: true, section: 'primary' },
  // Footer cluster — below the spacer.
  { id: 'help', icon: 'help', label: 'Help', hint: 'How to use K — open the guide', enabled: true, section: 'footer' },
  { id: 'settings', icon: 'settings', label: 'Settings', hint: 'Provider/auth status, diagnostics & global system prompt', enabled: true, section: 'footer' },
  // Hidden: not rail destinations, kept so TopBar can resolve a label for indirectly-reached views.
  { id: 'docs', icon: 'docs', label: 'Docs', hint: 'Harness bible & artifacts', enabled: true, view: 'docs', param: 'project-bible', section: 'hidden' },
  { id: 'skill-creator', icon: 'skillCreator', label: 'Skill Creator', hint: 'Draft, refine & evaluate a skill with an agent', enabled: true, section: 'hidden' },
  { id: 'timeline', icon: 'timeline', label: 'Timeline', hint: 'Org activity feed', enabled: true, section: 'hidden' },
]

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
  // refetchInterval restores the every-page 10s poll ActivityStrip provided before it was
  // retired: on views where a WS run_update could be dropped without a reconnect-triggered
  // invalidation (Agents/Insights/Projects/Settings), the badge would otherwise read stale.
  // Dedups with the Home/Runs widgets' identical poll on the shared key where they're mounted.
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn, refetchInterval: 10_000 })
  const activeRuns = runs.filter(isActiveRun).length
  const parkedRuns = runs.filter(isParkedRun).length
  const badgeCount = activeRuns + parkedRuns
  // LOW-2: the title must name the SAME number the badge shows. Parked-only
  // (activeRuns === 0) keeps the plain "N awaiting your input" phrasing; once
  // active runs are mixed in, badgeCount > parkedRuns, so the title leads with
  // the displayed total and then calls out the parked subset — otherwise a
  // badge reading "2" paired with a title reading "1 run awaiting your input"
  // reads as a mismatch/typo.
  const runsBadgeTitle =
    parkedRuns === 0
      ? badgeCount > 0
        ? `${badgeCount} active run${badgeCount > 1 ? 's' : ''}`
        : undefined
      : activeRuns > 0
        ? `${badgeCount} runs — ${parkedRuns} awaiting your input`
        : `${parkedRuns} run${parkedRuns > 1 ? 's' : ''} awaiting your input`

  // Inbox needs-YOU badge — shares the ONE inbox query (lib/inbox-query.ts) with
  // the page + invalidators, so this adds zero fetches (the Runs-badge pattern).
  const { data: inbox } = useQuery<InboxPayload>({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const inboxCount = inbox?.total ?? 0

  const renderButton = (d: Destination) => {
    const target = d.view ?? d.id
    // Help is a dialog (FE-6), not a route — it never matches `active`, so
    // isActive stays false for it regardless of the current view.
    const isActive = d.id !== 'help' && active === target
    return (
      <button
        key={d.id}
        title={d.enabled ? `${d.label} — ${d.hint}` : d.label}
        aria-label={d.label}
        disabled={!d.enabled}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => (d.id === 'help' ? openHelp() : navigate(target, d.param))}
        className={cn(
          'group relative flex h-10 items-center gap-3 rounded-control border border-transparent text-sm transition-all duration-150',
          collapsed ? 'w-10 justify-center px-0' : 'w-full px-3',
          d.enabled
            ? 'text-[var(--muted)] hover:border-[color:rgba(56,189,248,0.35)] hover:bg-[var(--raised)] hover:text-[var(--text)]'
            : 'cursor-default text-[color:rgba(169,155,196,0.4)]',
          isActive && 'bg-raised text-[var(--text)]'
        )}
      >
        {/* Active indicator — a blush bar on the rail's left edge, in place of the
            old tinted border/background pill. Works identically collapsed/expanded
            since the button itself (not a wrapper) is `relative`. */}
        {isActive && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-pill bg-accent"
          />
        )}
        <span
          className={cn(
            'flex w-5 shrink-0 items-center justify-center transition-colors',
            isActive ? 'text-[var(--accent-hover)]' : 'group-hover:text-[var(--accent-hover)]'
          )}
        >
          <Icon name={d.icon} size={16} />
        </span>
        {!collapsed && <span className="truncate">{d.label}</span>}
        {!collapsed && d.id === 'personal' && inboxCount > 0 && (
          <span
            data-testid="sidebar-personal-badge"
            title={`${inboxCount} item${inboxCount > 1 ? 's' : ''} waiting on you`}
            className="mono ml-auto rounded px-1.5 text-micro font-semibold bg-amber/20 text-[var(--amber)]"
          >
            {inboxCount}
          </span>
        )}
        {!collapsed && d.id === 'runs' && badgeCount > 0 && (
          <span
            data-testid="sidebar-runs-badge"
            title={runsBadgeTitle}
            className={cn(
              'mono ml-auto rounded px-1.5 text-micro font-semibold',
              // Amber = attention: at least one run is parked awaiting input.
              // NOTE: colors here are LOCKED — web/test/sidebar-toggle.test.tsx
              // asserts the literal substring 'text-[var(--amber)]' on this badge;
              // do not rewrite to the semantic `text-amber` token (see task-13 brief).
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
        // glass-chrome supplies its own 4-side border shorthand; this is a
        // full-height structural rail (not a floating chip), so zero 3 sides and
        // keep only the right-edge divider — matching --border (not the tier's
        // own --glass-tier-border) so the hairline reads identically to TopBar's
        // own border-b where the two chrome bars meet at the corner.
        'relative row-span-3 z-10 flex flex-col gap-1 glass-chrome border-l-0 border-t-0 border-b-0 border-r border-[var(--border)] py-3 transition-[width] duration-200',
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
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-control bg-gradient-to-br from-accent to-accent-hover"
            title="K"
          >
            <Icon name="bolt" size={20} className="text-on-accent" />
          </span>
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
          <Icon
            name={collapsed ? 'chevronRight' : 'arrowLeft'}
            size={16}
            className="transition-transform duration-[var(--dur-2)]"
          />
        </button>
      </div>

      {primary.map(renderButton)}

      <div className="flex-1" />

      {footer.map(renderButton)}
    </nav>
  )
}

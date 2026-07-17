import { useQuery } from '@tanstack/react-query'
import type { ChiefOrgLead, NamedWorkflow, Project } from '@k/shared'
import { DESTINATIONS } from './Sidebar'
import { api } from '../lib/api'
import { isKnownView, navigate } from '../lib/route'
import NotificationBell from '../components/NotificationBell'

interface Props {
  view: string
  /** The route's entity param (e.g. the orchestrator/workflow/project id) — lets the
   *  detail views render a "Parent › EntityName" breadcrumb instead of "Home". */
  param?: string
  connected: boolean
}

/** Detail views that aren't (or, for `timeline`, are only a hidden) Sidebar rail
 *  destination — each renders a breadcrumb back to its parent view (label/icon
 *  resolved from that parent's own DESTINATIONS entry) instead of falling through
 *  to the plain title (UI Simplification Task 10). */
const DETAIL_PARENTS: Record<string, string> = {
  orchestrator: 'agents',
  project: 'projects',
  timeline: 'home',
  'pr-review': 'projects',
}

/**
 * Resolve the current detail entity's display name. Each query reuses the EXACT
 * key + fn of the page that owns the view (OrchestratorDetailPage / WorkflowDetailPage /
 * ProjectsPage), so react-query dedupes against the page's own fetch — and each is
 * enabled ONLY on its view, so TopBar adds zero requests everywhere else.
 */
function useDetailName(view: string, param?: string): string | undefined {
  const orchestrator = useQuery<ChiefOrgLead>({
    queryKey: ['orchestrator', param],
    queryFn: () => api.orchestrators.get(param!),
    enabled: view === 'orchestrator' && !!param,
  })
  const workflow = useQuery<NamedWorkflow>({
    queryKey: ['workflow-def', param],
    queryFn: () => api.workflows.get(param!),
    enabled: view === 'workflow-detail' && !!param,
  })
  const projects = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
    enabled: view === 'project' && !!param,
  })
  if (view === 'orchestrator') return orchestrator.data?.profile.name
  if (view === 'workflow-detail') return workflow.data?.name
  if (view === 'project') return projects.data?.find(p => p.id === param)?.name
  return undefined
}

export default function TopBar({ view, param, connected }: Props) {
  const dest = DESTINATIONS.find(d => d.id === view)
  const parentView = DETAIL_PARENTS[view]
  const parentDest = parentView ? DESTINATIONS.find(d => d.id === parentView) : undefined
  const asyncDetailName = useDetailName(view, param)
  // Prefer the resolved entity name (orchestrator/project — neither is itself a
  // Sidebar destination, so `dest` is undefined for them). A parent-less detail
  // that IS its own hidden destination (timeline) has no entity to resolve —
  // fall back to its own label so the breadcrumb still names it, not just "K".
  const detailName = asyncDetailName ?? dest?.label
  // An unrouted hash must not masquerade as Home — surface the not-found state.
  const title = dest?.label.split(' ·')[0] ?? (isKnownView(view) ? 'Home' : 'Not found')
  return (
    <header className="relative z-20 flex items-center gap-4 glass-chrome border-x-0 border-t-0 border-b border-[var(--border)] px-5 py-3">
      <h1 data-testid="topbar-title" className="mr-auto text-sm font-semibold tracking-wide text-[var(--text)]">
        {parentDest ? (
          <>
            <button
              type="button"
              data-testid="topbar-parent"
              onClick={() => navigate(parentDest.id)}
              className="font-semibold text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
            >
              {parentDest.label}
            </button>
            {/* Until the entity name resolves, show only the parent — no dangling '›'. */}
            {detailName && (
              <>
                <span className="mx-1.5 text-[var(--muted)]">›</span>
                {detailName}
              </>
            )}
          </>
        ) : (
          title
        )}
      </h1>
      <NotificationBell />
      <span
        data-testid="ws-dot"
        data-ws-status={connected ? 'connected' : 'connecting'}
        title={connected ? 'core connected' : 'connecting…'}
        className="flex items-center gap-1.5 text-[11px] font-medium"
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${connected ? 'bg-green glow-live' : 'bg-amber animate-pulse'}`}
        />
        <span className={connected ? 'text-muted' : 'text-amber'}>
          {connected ? 'live' : 'connecting…'}
        </span>
      </span>
    </header>
  )
}

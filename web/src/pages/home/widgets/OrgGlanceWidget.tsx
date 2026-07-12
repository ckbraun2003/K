import { useQuery } from '@tanstack/react-query'
import type { ChiefOrgPayload } from '@k/shared'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'

/**
 * OrgGlanceWidget (UI Simplification Task 13) — ports KHome's glance line
 * (formerly KHome.tsx:148-172) into a widget cell: leads active · objectives
 * in flight, linking through to the Chief tree. `['chief-org']` is the
 * SAME key KHome/the Chief pages read, throttle-invalidated by the
 * Shell-level `run_update` handler, so this widget stays live without an
 * extra fetch path.
 *
 * `ChiefOrgPayload['health']` (shared/src/types.ts `ChiefOrgHealth`) exposes
 * only `leadsActive` — no score/band field — so this widget deliberately
 * omits a HealthRubric dot (the brief's own fallback: "omit the rubric if
 * not [exposed]"). Inventing a score here would violate the org payload's
 * D-026 honesty posture (real data only, never a synthesized band).
 */
export default function OrgGlanceWidget() {
  const { data: org, isError } = useQuery<ChiefOrgPayload>({ queryKey: ['chief-org'], queryFn: () => api.chief.org() })
  const leadsActive = org?.health.leadsActive ?? 0
  const objectives = org?.assignments.length ?? 0

  return (
    <button
      type="button"
      data-testid="widget-org-glance"
      onClick={() => navigate('agents', 'org', 'tree')}
      className="flex h-full w-full flex-col gap-2 overflow-y-auto p-3 text-left transition-colors hover:bg-[var(--raised)]"
    >
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Org at a glance</h2>
      {isError ? (
        <p data-testid="widget-org-glance-error" className="text-xs italic text-[var(--red)]">org status unavailable</p>
      ) : (
        <p className="text-sm text-[var(--muted)]">
          <span className="text-[var(--text)]">{leadsActive}</span> lead{leadsActive === 1 ? '' : 's'} active
          {' · '}
          <span className="text-[var(--text)]">{objectives}</span> objective{objectives === 1 ? '' : 's'} in flight
        </p>
      )}
      <span className="mt-auto text-[11px] text-[var(--accent-hover)]">Chief →</span>
    </button>
  )
}

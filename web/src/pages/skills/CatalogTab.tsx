import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CATALOG_HIGHLIGHT_KEY } from '../../lib/catalog-highlight'
import type { CatalogSkillsResponse, CatalogSkill, SkillSourceKind, ModelCompat } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { filterCatalog } from '../../lib/catalog-filter'
import { formatCompact } from '../../lib/format-metrics'
import { weightBand } from '../../lib/capability-tokens'
import { cn } from '../../lib/cn'
import SegControl from '../../components/SegControl'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'
import { GlassPanel } from '../../ui/GlassPanel'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonRow } from '../../ui/Skeleton'

// The unified capability catalog (D-069): every skill K can mount — its own
// library plus host-discovered user/project/plugin skills — with provenance,
// est-token cost and the K-scoped enable overlay. K never mutates host
// ~/.claude files; the dot only flips K's own overlay row.

// Non-canonical taxonomy (model compatibility, not a Run/AgentRun/DelegationNode
// status) — token-tint classes, never StatusPill.
const COMPAT_BADGE: Record<ModelCompat, string> = {
  'universal': 'bg-green/15 text-green',
  'claude-only': 'bg-amber/15 text-amber',
  'mcp-dependent': 'bg-accent-hover/15 text-accent-hover',
}

type SourceFacet = 'all' | SkillSourceKind
type CompatFacet = 'all' | ModelCompat

/** Relative context-weight meter (Impressive Wave Task 10 Step 5) — replaces the
 *  plain "heavy/medium/light weight" / "weight n/a" text chip with 3 lit pill
 *  bars (light=1, medium=2, heavy=3), honest via aria-label/title when unmeasured. */
function WeightMeter({ estTokens, refMax }: { estTokens: number | null; refMax: number }) {
  const band = weightBand(estTokens, refMax)
  const lit = band === 'light' ? 1 : band === 'medium' ? 2 : band === 'heavy' ? 3 : 0
  const label = band ? `${band} context weight` : 'not yet measured — probe or run to estimate'
  return (
    <span data-testid="catalog-weight-band" role="img" aria-label={label} title={label} className="inline-flex items-center gap-0.5">
      {[1, 2, 3].map(i => (
        <span key={i} className={cn('h-2.5 w-1 rounded-pill', lit >= i ? 'bg-accent-hover' : 'border border-border bg-transparent')} />
      ))}
    </span>
  )
}

export default function CatalogTab() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<CatalogSkillsResponse>({
    queryKey: ['capabilities', 'skills'],
    queryFn: api.capabilities.skills,
  })

  const [source, setSource] = useState<SourceFacet>('all')
  const [compat, setCompat] = useState<CompatFacet>('all')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [q, setQ] = useState('')
  // One-shot highlight of a skill just saved by the Skill Creator (D-071):
  // the save handoff parks the new row's id in sessionStorage; we consume it
  // once on mount so a reload doesn't re-highlight.
  const [highlightId] = useState<string | null>(() => {
    try {
      const id = sessionStorage.getItem(CATALOG_HIGHLIGHT_KEY)
      if (id !== null) sessionStorage.removeItem(CATALOG_HIGHLIGHT_KEY)
      return id
    } catch {
      return null
    }
  })

  // The whole ['capabilities'] family refreshes on any overlay change — the
  // stat strip (summary) and mountedBy views must never disagree with the list.
  const invalidateCapabilities = () => void qc.invalidateQueries({ queryKey: ['capabilities'] })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.capabilities.toggleSkill(id, enabled),
    onSuccess: invalidateCapabilities,
    // Errors surface in-row (a missing skill 400s fail-closed) — not swallowed.
  })

  const rescanMutation = useMutation({
    mutationFn: () => api.capabilities.rescan(),
    onSuccess: invalidateCapabilities,
  })

  const skills = data?.skills ?? []
  const refMax = skills.reduce((m, s) => Math.max(m, s.estTokens ?? 0), 1)
  const warnings = data?.warnings ?? []
  const filtered = filterCatalog(skills, {
    sourceKind: source === 'all' ? undefined : source,
    compat: compat === 'all' ? undefined : compat,
    enabledOnly,
    q,
  })

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header — count + rescan. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-label uppercase tracking-wide text-muted">
          Capability catalog · {skills.length} skill{skills.length === 1 ? '' : 's'}
          {data?.scannedAt != null && (
            <span className="ml-2 normal-case tracking-normal">
              scanned {new Date(data.scannedAt).toLocaleString()}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {rescanMutation.isError && (
            <span data-testid="catalog-rescan-error" className="text-caption text-red">
              {(rescanMutation.error as Error).message}
            </span>
          )}
          <Button
            variant="glass"
            size="sm"
            onClick={() => rescanMutation.mutate()}
            disabled={rescanMutation.isPending}
            loading={rescanMutation.isPending}
            icon="refresh"
            data-testid="catalog-rescan"
          >
            {rescanMutation.isPending ? 'rescanning…' : 'rescan host'}
          </Button>
          {/* Skill Creator entry (D-071) — the hidden #/skill-creator route. */}
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate('skill-creator')}
            data-testid="skill-creator-open"
            icon="plus"
          >
            create with agent
          </Button>
        </div>
      </div>

      {/* Filters — source/compat facets, enabled-only, text search. */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <SegControl<SourceFacet>
          options={[
            { label: 'All', value: 'all' },
            { label: 'K', value: 'k' },
            { label: 'User', value: 'claude-user' },
            { label: 'Project', value: 'claude-project' },
            { label: 'Plugin', value: 'claude-plugin' },
          ]}
          value={source}
          onChange={setSource}
        />
        <SegControl<CompatFacet>
          options={[
            { label: 'Any model', value: 'all' },
            { label: 'Universal', value: 'universal' },
            { label: 'Claude-only', value: 'claude-only' },
            { label: 'MCP-dep', value: 'mcp-dependent' },
          ]}
          value={compat}
          onChange={setCompat}
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-caption text-muted">
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={e => setEnabledOnly(e.target.checked)}
            data-testid="catalog-enabled-only"
            className="accent-accent"
          />
          enabled only
        </label>
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="search skills…"
          aria-label="Search catalog"
          data-testid="catalog-search"
          className="min-w-[10rem] flex-1"
        />
      </div>

      <div className="mt-4">
        <WarningsBanner warnings={warnings} />

        {isLoading && (
          <div className="mt-6 flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {isError && <ErrorState message="Failed to load the capability catalog." />}
        {!isLoading && !isError && skills.length === 0 && (
          <div data-testid="catalog-empty" className="mt-6">
            <EmptyState
              icon="agents"
              headline={
                warnings.length > 0
                  ? 'Host discovery found nothing readable.'
                  : 'Nothing in the catalog yet — rescan to discover host skills.'
              }
            />
          </div>
        )}
        {!isLoading && !isError && skills.length > 0 && filtered.length === 0 && (
          <p className="mt-10 text-center text-caption text-muted">
            No entries match the current filters.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {filtered.map(skill => (
            <CatalogRow
              key={skill.id}
              skill={skill}
              refMax={refMax}
              highlighted={skill.id === highlightId}
              onToggle={enabled => toggleMutation.mutate({ id: skill.id, enabled })}
              togglePending={toggleMutation.isPending && toggleMutation.variables?.id === skill.id}
              toggleError={
                toggleMutation.isError && toggleMutation.variables?.id === skill.id
                  ? (toggleMutation.error as Error).message
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function CatalogRow({
  skill,
  refMax,
  highlighted,
  onToggle,
  togglePending,
  toggleError,
}: {
  skill: CatalogSkill
  refMax: number
  /** One-shot emphasis for a row just saved by the Skill Creator. */
  highlighted?: boolean
  onToggle: (enabled: boolean) => void
  togglePending: boolean
  toggleError?: string
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const missing = skill.status === 'missing'
  return (
    <GlassPanel
      // solid, not glass: a filtered catalog can show dozens of rows at once —
      // well past the ≤6-blurred-region budget (same call as RosterView's
      // lead cards / DEV-11's fleet project grid).
      tier="solid"
      data-testid={`catalog-row-${skill.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(highlighted && 'border-accent/50 ring-1 ring-accent/30', missing && 'opacity-70')}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* K-scoped enable overlay dot — the SkillRow enable-dot pattern. A
            missing entry can't be enabled (fail-closed server-side too). */}
        <button
          role="switch"
          aria-checked={skill.enabled}
          aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
          title={missing ? 'Missing on disk — cannot be enabled' : skill.enabled ? 'Disable (K-scoped)' : 'Enable (K-scoped)'}
          disabled={togglePending || (missing && !skill.enabled)}
          onClick={() => onToggle(!skill.enabled)}
          data-testid={`catalog-toggle-${skill.id}`}
          className={cn(
            'h-4 w-4 flex-shrink-0 rounded-pill border transition-colors disabled:opacity-50 glow-focus',
            skill.enabled ? 'border-accent bg-accent' : 'border-border bg-transparent',
          )}
        />

        {/* Name + badges */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-text">{skill.name}</span>
            <SourceBadge sourceKind={skill.sourceKind} pluginName={skill.pluginName} />
            <span
              className={cn('rounded-pill px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide', COMPAT_BADGE[skill.modelCompat])}
            >
              {skill.modelCompat}
            </span>
            {/* Relative context-weight meter — a token-count fraction of the catalog's
                heaviest entry (E-13); never a dollar cost. Honest about absence. */}
            <WeightMeter estTokens={skill.estTokens} refMax={refMax} />
            {missing && (
              <span
                data-testid={`catalog-missing-${skill.id}`}
                className="rounded-pill bg-red/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-red"
              >
                missing on disk
              </span>
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 truncate text-caption text-muted">{skill.description}</p>
          )}
          {/* Mounted-by — which profiles carry this skill right now. */}
          {skill.mountedBy.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-micro text-muted">mounted by</span>
              {skill.mountedBy.map(pid => (
                <button
                  key={pid}
                  onClick={() => navigate('orchestrator', pid)}
                  data-testid={`catalog-mountedby-${skill.id}-${pid}`}
                  className="rounded-pill bg-raised px-1.5 py-0.5 text-micro text-accent-hover transition-colors hover:bg-border"
                >
                  {pid} →
                </button>
              ))}
            </div>
          )}
          {toggleError && (
            <p data-testid={`catalog-toggle-error-${skill.id}`} className="mt-0.5 text-caption text-red">
              {toggleError}
            </p>
          )}
        </div>

        {/* Read-only provenance preview toggle. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPreviewOpen(o => !o)}
          aria-expanded={previewOpen}
          data-testid={`catalog-preview-toggle-${skill.id}`}
          icon={previewOpen ? 'chevronDown' : 'chevronRight'}
          className="flex-shrink-0"
        >
          details
        </Button>
      </div>

      {previewOpen && (
        <div
          data-testid={`catalog-preview-${skill.id}`}
          className="border-t border-border px-4 py-3"
        >
          <dl className="space-y-1 text-caption">
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-muted">SKILL.md</dt>
              <dd className="mono min-w-0 break-all text-text">{skill.path}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-muted">qualified key</dt>
              <dd className="mono min-w-0 break-all text-text">{skill.id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-muted">description</dt>
              <dd className="min-w-0 text-text">{skill.description ?? <span className="italic text-muted">none</span>}</dd>
            </div>
            {skill.estTokensMeta !== null && (
              <div className="flex gap-2">
                <dt className="w-24 flex-shrink-0 text-muted">always-loaded</dt>
                <dd className="mono text-text">~{formatCompact(skill.estTokensMeta)} tok (name + description)</dd>
              </div>
            )}
          </dl>
          <p className="mt-2 text-micro italic text-muted">
            Read-only — discovered skills are vendor-copied into each run's config at dispatch;
            K never edits host files.
          </p>
        </div>
      )}
    </GlassPanel>
  )
}

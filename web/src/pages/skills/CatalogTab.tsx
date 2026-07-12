import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CATALOG_HIGHLIGHT_KEY } from '../../lib/catalog-highlight'
import type { CatalogSkillsResponse, CatalogSkill, SkillSourceKind, ModelCompat } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { filterCatalog } from '../../lib/catalog-filter'
import { formatCompact } from '../../lib/format-metrics'
import { weightBand } from '../../lib/capability-tokens'
import SegControl from '../../components/SegControl'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'

// The unified capability catalog (D-069): every skill K can mount — its own
// library plus host-discovered user/project/plugin skills — with provenance,
// est-token cost and the K-scoped enable overlay. K never mutates host
// ~/.claude files; the dot only flips K's own overlay row.

const COMPAT_BADGE: Record<ModelCompat, string> = {
  'universal': 'bg-green-500/20 text-green-300',
  'claude-only': 'bg-orange-500/20 text-orange-300',
  'mcp-dependent': 'bg-blue-500/20 text-blue-300',
}

type SourceFacet = 'all' | SkillSourceKind
type CompatFacet = 'all' | ModelCompat

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
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Capability catalog · {skills.length} skill{skills.length === 1 ? '' : 's'}
          {data?.scannedAt != null && (
            <span className="ml-2 normal-case tracking-normal">
              scanned {new Date(data.scannedAt).toLocaleString()}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {rescanMutation.isError && (
            <span data-testid="catalog-rescan-error" className="text-xs text-red-400">
              {(rescanMutation.error as Error).message}
            </span>
          )}
          <button
            onClick={() => rescanMutation.mutate()}
            disabled={rescanMutation.isPending}
            data-testid="catalog-rescan"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {rescanMutation.isPending ? 'rescanning…' : '⟳ rescan host'}
          </button>
          {/* Skill Creator entry (D-071) — the hidden #/skill-creator route. */}
          <button
            onClick={() => navigate('skill-creator')}
            data-testid="skill-creator-open"
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90"
          >
            + create with agent
          </button>
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
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={e => setEnabledOnly(e.target.checked)}
            data-testid="catalog-enabled-only"
            className="accent-[var(--accent)]"
          />
          enabled only
        </label>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="search skills…"
          aria-label="Search catalog"
          data-testid="catalog-search"
          className="min-w-[10rem] flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
        />
      </div>

      <div className="mt-4">
        <WarningsBanner warnings={warnings} />

        {isLoading && <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading…</p>}
        {isError && (
          <p className="mt-10 text-center text-sm text-[var(--red)]">Failed to load the capability catalog.</p>
        )}
        {!isLoading && !isError && skills.length === 0 && (
          <p data-testid="catalog-empty" className="mt-10 text-center text-sm text-[var(--muted)]">
            {warnings.length > 0
              ? 'Host discovery found nothing readable.'
              : 'Nothing in the catalog yet — rescan to discover host skills.'}
          </p>
        )}
        {!isLoading && !isError && skills.length > 0 && filtered.length === 0 && (
          <p className="mt-10 text-center text-sm text-[var(--muted)]">
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
    <div
      data-testid={`catalog-row-${skill.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`rounded-xl border bg-[var(--surface)] ${
        highlighted ? 'border-[color:rgba(255,143,192,0.5)] shadow-[0_0_0_1px_rgba(255,143,192,0.3)]' : 'border-[var(--border)]'
      } ${missing ? 'opacity-70' : ''}`}
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
          className={`h-4 w-4 flex-shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
            skill.enabled
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-[var(--border)] bg-transparent'
          }`}
        />

        {/* Name + badges */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--text)]">{skill.name}</span>
            <SourceBadge sourceKind={skill.sourceKind} pluginName={skill.pluginName} />
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${COMPAT_BADGE[skill.modelCompat]}`}
            >
              {skill.modelCompat}
            </span>
            {/* Relative context-weight band — a token-count fraction of the catalog's
                heaviest entry (E-13); never a dollar cost. Honest about absence. */}
            {(() => {
              const band = weightBand(skill.estTokens, refMax)
              const tone = band === 'heavy' ? 'text-[var(--amber)]' : band === 'medium' ? 'text-[var(--text)]' : 'text-[var(--muted)]'
              return (
                <span
                  data-testid="catalog-weight-band"
                  title={band ? `relative context weight: ${band}` : 'context weight not measured'}
                  className={`rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] ${tone}`}
                >
                  {band ? `${band} weight` : 'weight n/a'}
                </span>
              )
            })()}
            {missing && (
              <span
                data-testid={`catalog-missing-${skill.id}`}
                className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300"
              >
                missing on disk
              </span>
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 truncate text-xs text-[var(--muted)]">{skill.description}</p>
          )}
          {/* Mounted-by — which profiles carry this skill right now. */}
          {skill.mountedBy.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-[var(--muted)]">mounted by</span>
              {skill.mountedBy.map(pid => (
                <button
                  key={pid}
                  onClick={() => navigate('orchestrator', pid)}
                  data-testid={`catalog-mountedby-${skill.id}-${pid}`}
                  className="rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--accent-hover)] transition-colors hover:bg-[var(--border)]"
                >
                  {pid} →
                </button>
              ))}
            </div>
          )}
          {toggleError && (
            <p data-testid={`catalog-toggle-error-${skill.id}`} className="mt-0.5 text-xs text-red-400">
              {toggleError}
            </p>
          )}
        </div>

        {/* Read-only provenance preview toggle. */}
        <button
          onClick={() => setPreviewOpen(o => !o)}
          aria-expanded={previewOpen}
          data-testid={`catalog-preview-toggle-${skill.id}`}
          className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          {previewOpen ? '▾ details' : '▸ details'}
        </button>
      </div>

      {previewOpen && (
        <div
          data-testid={`catalog-preview-${skill.id}`}
          className="border-t border-[var(--border)] px-4 py-3"
        >
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-[var(--muted)]">SKILL.md</dt>
              <dd className="mono min-w-0 break-all text-[var(--text)]">{skill.path}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-[var(--muted)]">qualified key</dt>
              <dd className="mono min-w-0 break-all text-[var(--text)]">{skill.id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 flex-shrink-0 text-[var(--muted)]">description</dt>
              <dd className="min-w-0 text-[var(--text)]">{skill.description ?? <span className="italic text-[var(--muted)]">none</span>}</dd>
            </div>
            {skill.estTokensMeta !== null && (
              <div className="flex gap-2">
                <dt className="w-24 flex-shrink-0 text-[var(--muted)]">always-loaded</dt>
                <dd className="mono text-[var(--text)]">~{formatCompact(skill.estTokensMeta)} tok (name + description)</dd>
              </div>
            )}
          </dl>
          <p className="mt-2 text-[11px] italic text-[var(--muted)]">
            Read-only — discovered skills are vendor-copied into each run's config at dispatch;
            K never edits host files.
          </p>
        </div>
      )}
    </div>
  )
}

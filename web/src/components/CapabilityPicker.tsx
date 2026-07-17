import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentProfile, CatalogSkillsResponse, CatalogMcpResponse } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { formatCompact } from '../lib/format-metrics'
import { profileSubtotal } from '../lib/capability-tokens'
import SourceBadge from './SourceBadge'
import { Input } from '../ui/Field'

/**
 * Catalog-backed mount editor for a profile's skills / MCP servers (wave C3) —
 * replaces the free-text add-by-name forms on the Orchestrator detail and the
 * org-default section. Mounted rows carry provenance + token cost; the add
 * combobox offers only catalog entries, with disabled/untrusted ones grayed
 * (operator enablement is a PRECONDITION — enable in the catalog first, then
 * mount). Values stay plain string[] qualified keys; the PARENT owns the PATCH
 * mutation and its error banner (grant-guard 400s surface there verbatim).
 */

/** One normalized catalog candidate (skill or server) for rendering. */
interface Entry {
  id: string
  name: string
  sourceKind: CatalogSkillsResponse['skills'][number]['sourceKind']
  pluginName: string | null
  estTokens: number | null
  /** Mountable right now (enabled + trusted-if-mcp + present on disk). */
  addable: boolean
  /** Why it is NOT addable — shown grayed in the combobox. */
  blockReason: string | null
}

export default function CapabilityPicker({
  kind,
  profile,
  onChange,
  busy,
  testidPrefix,
  title,
}: {
  kind: 'skills' | 'mcp'
  /** The whole authority pair — the footer subtotal prices the full profile. */
  profile: Pick<AgentProfile, 'skills' | 'mcpServers'>
  onChange: (next: string[]) => void
  busy: boolean
  /** Existing testid vocabulary is preserved: `${prefix}-input`, `${prefix}-remove-<key>`… */
  testidPrefix: string
  /** Optional column heading (the Settings grid renders one per column). */
  title?: string
}) {
  const { data: skillsRes } = useQuery<CatalogSkillsResponse>({
    queryKey: ['capabilities', 'skills'],
    queryFn: api.capabilities.skills,
  })
  const { data: mcpRes } = useQuery<CatalogMcpResponse>({
    queryKey: ['capabilities', 'mcp'],
    queryFn: api.capabilities.mcp,
  })

  const mounted = kind === 'skills' ? profile.skills : profile.mcpServers

  // Normalize the edited side to one candidate shape. MCP adds also require
  // trust (D-070) — an enabled-but-untrusted server can't exist server-side,
  // but the guard here keeps the UI honest even on stale cache.
  const entries: Entry[] = useMemo(() => {
    if (kind === 'skills') {
      return (skillsRes?.skills ?? []).map(s => ({
        id: s.id,
        name: s.name,
        sourceKind: s.sourceKind,
        pluginName: s.pluginName,
        estTokens: s.estTokens,
        addable: s.enabled && s.status === 'ok',
        blockReason:
          s.status === 'missing'
            ? 'missing on disk'
            : !s.enabled
              ? 'disabled — enable it in the catalog first'
              : null,
      }))
    }
    return (mcpRes?.servers ?? []).map(s => ({
      id: s.id,
      name: s.name,
      sourceKind: s.sourceKind,
      pluginName: s.pluginName,
      estTokens: s.estTokens,
      addable: s.enabled && s.trusted && s.status === 'ok',
      blockReason:
        s.status === 'missing'
          ? 'missing from the host config'
          : !s.trusted
            ? 'untrusted — enable it in the catalog first'
            : !s.enabled
              ? 'disabled — enable it in the catalog first'
              : null,
    }))
  }, [kind, skillsRes, mcpRes])

  const entryById = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries])

  const [query, setQuery] = useState('')
  // Combobox visibility + keyboard cursor. `open` tracks focus-within on the
  // whole widget (input AND options/deep-link), so tabbing to the catalog link
  // doesn't collapse the list; Escape closes explicitly. `sel` is the roving
  // arrow-key selection (-1 = none) — the input keeps DOM focus (ARIA combobox
  // pattern) and points at the active option via aria-activedescendant.
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(-1)
  // The add awaiting its PATCH round-trip: clear the input only once the value
  // LANDS in the refetched list, so a grant-guard rejection keeps the typed
  // text (the AuthorityList pending pattern).
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    if (pending && mounted.includes(pending)) {
      setQuery('')
      setPending(null)
    }
  }, [mounted, pending])

  const q = query.trim().toLowerCase()
  const candidates = entries
    .filter(e => !mounted.includes(e.id))
    .filter(e => q === '' || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
    .sort((a, b) => Number(b.addable) - Number(a.addable) || a.name.localeCompare(b.name))
  const comboOpen = open
  // The roving cursor can outlive a shrinking candidate list — clamp at use.
  const selected = sel >= 0 && sel < candidates.length ? candidates[sel] : undefined

  const subtotal =
    skillsRes && mcpRes ? profileSubtotal(profile, skillsRes.skills, mcpRes.servers) : null

  function handleAdd(entry: Entry) {
    if (!entry.addable || busy || mounted.includes(entry.id)) return
    setPending(entry.id)
    onChange([...mounted, entry.id])
  }

  const catalogHash = kind === 'skills' ? undefined : 'mcp'
  const noun = kind === 'skills' ? 'skill' : 'MCP server'

  return (
    <div className="space-y-2" data-testid={`${testidPrefix}-panel`}>
      {title && (
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      )}

      {/* Mounted rows — provenance + cost + remove. */}
      {mounted.length === 0 ? (
        <p className="text-xs italic text-muted">No {noun}s mounted.</p>
      ) : (
        <ul className="space-y-1">
          {mounted.map(key => {
            const hit = entryById.get(key)
            return (
              <li
                key={key}
                className="flex items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1.5 text-xs"
              >
                {hit ? (
                  <>
                    <span className="min-w-0 flex-1 truncate text-text" title={hit.id}>
                      {hit.name}
                    </span>
                    <SourceBadge sourceKind={hit.sourceKind} pluginName={hit.pluginName} />
                    <span className="mono rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                      {hit.estTokens !== null ? `~${formatCompact(hit.estTokens)} tok` : 'tok n/a'}
                    </span>
                    {hit.blockReason && (
                      // A mounted entry that is no longer mountable (disabled /
                      // untrusted / missing since) — dispatch will fail-close on
                      // it, so say so here instead of looking healthy.
                      <span
                        data-testid={`${testidPrefix}-stale-${key}`}
                        title={hit.blockReason}
                        className="rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber"
                      >
                        {hit.blockReason.split(' — ')[0]}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="mono min-w-0 flex-1 truncate text-text">{key}</span>
                    <span
                      data-testid={`${testidPrefix}-ghost-${key}`}
                      title="No catalog row matches this entry — it is excluded from the token subtotal."
                      className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                    >
                      not in catalog
                    </span>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChange(mounted.filter(k => k !== key))}
                  data-testid={`${testidPrefix}-remove-${key}`}
                  className="flex-shrink-0 text-red hover:underline disabled:opacity-50"
                >
                  remove
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Add combobox — catalog-backed; disabled/untrusted entries grayed.
          Focus-within keeps the list open while tabbing to the deep link;
          the input owns DOM focus and arrows/Enter drive the roving cursor. */}
      <div
        className="relative"
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={e => {
          // Close only when focus truly LEAVES the widget (input ⇄ options ⇄
          // deep-link moves keep it open). relatedTarget is null on window blur.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setOpen(false)
            setSel(-1)
          }
        }}
      >
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault()
            // Enter adds the arrow-selected candidate, else an EXACT match —
            // and only if addable, so a grayed entry can't sneak in through
            // the keyboard (disabled-add prevention).
            const target =
              selected ?? candidates.find(c => c.name === query.trim() || c.id === query.trim())
            if (target) handleAdd(target)
          }}
        >
          <Input
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setOpen(true)
              setSel(-1)
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setOpen(true)
                setSel(s => Math.min(s + 1, candidates.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel(s => Math.max(s - 1, -1))
              } else if (e.key === 'Escape') {
                setOpen(false)
                setSel(-1)
              }
            }}
            placeholder={`add ${noun} from catalog`}
            role="combobox"
            aria-expanded={comboOpen}
            aria-controls={`${testidPrefix}-options`}
            aria-autocomplete="list"
            aria-activedescendant={selected ? `${testidPrefix}-option-${selected.id}` : undefined}
            data-testid={`${testidPrefix}-input`}
            className="min-w-0 flex-1 px-2 py-1 text-xs"
          />
        </form>
        {comboOpen && (
          <div
            id={`${testidPrefix}-options`}
            role="listbox"
            data-testid={`${testidPrefix}-options`}
            className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
          >
            {candidates.length === 0 && (
              <p className="px-2 py-1.5 text-[11px] italic text-muted">
                {entries.length === 0
                  ? 'Catalog not loaded (or empty) — rescan on the Skills page.'
                  : 'No unmounted catalog entries match.'}
              </p>
            )}
            {candidates.map((c, i) => (
              <button
                key={c.id}
                type="button"
                id={`${testidPrefix}-option-${c.id}`}
                role="option"
                aria-selected={i === sel}
                aria-disabled={!c.addable}
                // Options are NOT tab stops (the input owns focus per the ARIA
                // combobox pattern); mousedown only keeps the input focused so
                // the click can land while the focus-gated list stays open.
                tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onClick={() => handleAdd(c)}
                data-testid={`${testidPrefix}-option-${c.id}`}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                  c.addable
                    ? 'text-text hover:bg-raised'
                    : 'cursor-not-allowed text-muted opacity-60'
                } ${i === sel ? 'bg-raised' : ''} ${busy ? 'pointer-events-none opacity-50' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate" title={c.id}>{c.name}</span>
                <SourceBadge sourceKind={c.sourceKind} pluginName={c.pluginName} />
                <span className="mono text-[10px]">
                  {c.estTokens !== null ? `~${formatCompact(c.estTokens)} tok` : 'tok n/a'}
                </span>
                {!c.addable && <span className="text-[10px] italic">{c.blockReason}</span>}
              </button>
            ))}
            {candidates.some(c => !c.addable) && (
              <button
                type="button"
                // Tabbable on purpose — keyboard users need the deep link; the
                // focus-within gate keeps the list open while it has focus.
                onMouseDown={e => e.preventDefault()}
                onClick={() => navigate('agents', 'catalog', catalogHash)}
                data-testid={`${testidPrefix}-catalog-link`}
                className="mt-0.5 w-full rounded-md px-2 py-1.5 text-left text-[11px] text-accent-hover hover:bg-raised"
              >
                open the catalog to enable more →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer — the profile's estimated context overhead (both sides, one figure). */}
      {subtotal && (
        <p data-testid={`${testidPrefix}-subtotal`} className="text-[11px] text-muted">
          Profile context overhead:{' '}
          <span className="mono text-text">~{formatCompact(subtotal.totalEstTokens)} tok</span>{' '}
          (skills ~{formatCompact(subtotal.skills.estTokens)} · MCP ~{formatCompact(subtotal.mcp.estTokens)})
          {subtotal.unestimatedCount > 0 && <> · {subtotal.unestimatedCount} not yet measured</>}
          {subtotal.notInCatalog.length > 0 && <> · {subtotal.notInCatalog.length} not in catalog (excluded)</>}
        </p>
      )}
    </div>
  )
}

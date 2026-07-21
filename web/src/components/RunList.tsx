import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { RUNS_LIST_KEY, RUNS_LIST_LIMIT, isActiveRun, isParkedRun } from '../lib/runs-query'
import { cleanRunPrompt } from '../lib/prompt'
import { runDuration } from '../lib/format-metrics'
import ConfirmDialog from './ConfirmDialog'
import { Checkbox } from '../ui/Field'
import { Tag } from '../ui/Tag'
import { StatusPill } from '../ui/StatusPill'
import { Button, IconButton } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { SkeletonRow } from '../ui/Skeleton'
import { Row } from '../ui/Row'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
}

// Lane B (B5, runs consolidation): GET /api/runs annotates each row with `archived`
// ONLY when the caller isn't in default 'exclude' mode (see routes/runs.ts) — a
// list-only field the shared Run wire schema deliberately doesn't carry (archived
// state lives in app_config, not a runs column). Optional here for exactly that
// reason: a plain `Run` (every other consumer of api.runs.list) is still assignable.
type RunRow = Run & { archived?: boolean }

type FilterKey = 'all' | 'active' | 'done' | 'error' | 'killed' | 'interrupted'

const FILTERS: FilterKey[] = ['all', 'active', 'done', 'error', 'killed', 'interrupted']

function matchesFilter(run: Run, filter: FilterKey): boolean {
  if (filter === 'all') return true
  // "active" folds in parked (awaiting_input) runs — they hold a live CLI process
  // needing operator attention, so they must not read as inactive (F-055).
  if (filter === 'active') return isActiveRun(run) || isParkedRun(run)
  return run.status === filter
}

function countFilter(runs: Run[], filter: FilterKey): number {
  return runs.filter(r => matchesFilter(r, filter)).length
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`
  return `${n} tok`
}

// A.3 (D-127): RunList's list is now KIND-scoped (chat turns hidden by default via
// the server-side filter), so it owns a scoped query key — per the runs-query.ts
// rule, a FILTERED list must never share the default RUNS_LIST_KEY cache entry.
// Lane B (B5): the archived-visibility toggle is a second filter dimension on the
// same scoped key (same rule applies — it's not the default-limit unfiltered list).
const runListKey = (showChatTurns: boolean, showArchived: boolean) =>
  ['runs', { limit: RUNS_LIST_LIMIT, showChatTurns, showArchived }] as const

export default function RunList({ selectedId, onSelect }: Props) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<FilterKey>('all')
  // A.3 (D-127): chat-turn runs are conversation traffic (the Messages surface),
  // hidden from the runs list by default via the server-side kind filter.
  const [showChatTurns, setShowChatTurns] = useState(false)
  // Lane B (B5): archived runs are hidden by default (server `archived=exclude`);
  // toggling this asks the server for `archived=include` so both sets render
  // together (archived rows get a muted "Archived" tag — see the row render below).
  const [showArchived, setShowArchived] = useState(false)
  // Run pending kill-confirmation (null = no dialog).
  const [pendingKill, setPendingKill] = useState<Run | null>(null)
  const [killing, setKilling] = useState(false)

  // Lane B (B5): bulk multi-select for archive/unarchive/delete. Distinct from
  // `selectedId` (the single run open in RunDetail) — this is a separate set of
  // ids checked via the per-row checkbox for the bulk-action bar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  // RunList's KIND-scoped list (chat turns excluded unless toggled). The key
  // carries the toggle so each scope caches separately; the shared default-list
  // entry (RUNS_LIST_KEY: ActiveRunsWidget + Sidebar) stays untouched per the
  // runs-query.ts scoping rule.
  const { data: runs = [], isLoading } = useQuery<RunRow[]>({
    queryKey: runListKey(showChatTurns, showArchived),
    queryFn: () => api.runs.list({
      limit: RUNS_LIST_LIMIT,
      kind: showChatTurns ? undefined : ['job', 'pipeline-stage'],
      archived: showArchived ? 'include' : 'exclude',
    }),
    refetchInterval: 5_000,
  })

  // Live updates via WebSocket. Two exact-key writes (a bare ['runs'] prefix would
  // create a third cache entry and reach nobody):
  //  - the SHARED default-list entry, unchanged, so its consumers (Sidebar badge,
  //    ActiveRunsWidget) stay live exactly as before;
  //  - THIS list's kind+archived-scoped entry — where a chat-turn update must not
  //    INSERT while the toggle is off (the server excludes them; an already-listed
  //    row still patches). The Shell-level ['runs'] prefix invalidation re-fetches
  //    both on every run_update regardless, so a skipped insert can't go stale —
  //    the same backstop covers the rare edge case of a run archived while parked
  //    (awaiting_input) later changing status: the WS patch below preserves each
  //    row's own `archived` flag (msg.run never carries one — that field is a
  //    list-only annotation, see RunRow) rather than guessing at it.
  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update') {
        const patch = (old?: RunRow[]): RunRow[] | undefined => {
          if (!old) return [msg.run]
          const idx = old.findIndex(r => r.id === msg.run.id)
          if (idx === -1) return [msg.run, ...old]
          const next = [...old]
          next[idx] = { ...msg.run, archived: old[idx].archived }
          return next
        }
        qc.setQueryData<Run[]>(RUNS_LIST_KEY, patch)
        qc.setQueryData<RunRow[]>(runListKey(showChatTurns, showArchived), old => {
          if (!showChatTurns && msg.run.kind === 'chat-turn' && !old?.some(r => r.id === msg.run.id)) return old
          return patch(old)
        })
      }
    })
  }, [qc, showChatTurns, showArchived])

  const filteredRuns = runs.filter(r => matchesFilter(r, filter))

  // Footer totals over filtered set
  const totalCost = filteredRuns.reduce((acc, r) => acc + r.costUsd, 0)
  const totalTokens = filteredRuns.reduce((acc, r) => acc + r.tokensIn + r.tokensOut, 0)
  const atLimit = runs.length === RUNS_LIST_LIMIT

  async function confirmKill() {
    if (!pendingKill) return
    setKilling(true)
    try {
      await api.runs.kill(pendingKill.id)
      setPendingKill(null)
    } finally {
      setKilling(false)
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function refreshLists() {
    qc.invalidateQueries({ queryKey: ['runs'] })
  }

  // One button covers both directions of the archive lifecycle (elegant over
  // adding a 4th bar button): if every selected row is already archived, it
  // unarchives; otherwise it archives. Server-side guards (archive refuses
  // running|queued) are the source of truth — a mixed/ineligible selection just
  // partially succeeds and the failure count is reported, no client-side gate.
  const selectedRuns = filteredRuns.filter(r => selectedIds.has(r.id))
  const allSelectedArchived = selectedRuns.length > 0 && selectedRuns.every(r => r.archived)

  async function runBulkArchiveToggle() {
    setBulkBusy(true)
    setBulkError(null)
    const ids = [...selectedIds]
    const fn = allSelectedArchived ? api.runs.unarchive : api.runs.archive
    const results = await Promise.allSettled(ids.map(id => fn(id)))
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) setBulkError(`${failed} of ${ids.length} run(s) could not be ${allSelectedArchived ? 'unarchived' : 'archived'}.`)
    setSelectedIds(new Set())
    setBulkBusy(false)
    refreshLists()
  }

  async function confirmBulkDelete() {
    setBulkBusy(true)
    setBulkError(null)
    const ids = [...selectedIds]
    const results = await Promise.allSettled(ids.map(id => api.runs.remove(id)))
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) setBulkError(`${failed} of ${ids.length} run(s) could not be deleted (must be archived first).`)
    setSelectedIds(new Set())
    setBulkBusy(false)
    setPendingBulkDelete(false)
    refreshLists()
  }

  async function runClearFinished() {
    setBulkBusy(true)
    setBulkError(null)
    try {
      await api.runs.clearFinished()
      refreshLists()
    } catch (err) {
      setBulkError(String(err))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="micro-label mb-2">Runs</h2>
        {/* Filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTERS.map(f => {
            const count = countFilter(runs, f)
            const isActive = filter === f
            return (
              <button
                key={f}
                type="button"
                data-testid={`run-filter-${f}`}
                onClick={() => setFilter(f)}
                aria-pressed={isActive}
                className="p-0 focus-visible:glow-focus rounded-pill"
              >
                <Tag tint={isActive ? 'accent' : 'neutral'}>
                  {f} <span className="mono tabular-nums">{count}</span>
                </Tag>
              </button>
            )
          })}
          {/* A.3 (D-127): opt chat-turn (conversation) runs back into the list. */}
          <label className="ml-auto flex items-center gap-1 text-label text-muted cursor-pointer">
            <Checkbox
              checked={showChatTurns}
              onChange={e => setShowChatTurns(e.target.checked)}
              data-testid="run-show-chat-turns"
            />
            Show chat turns
          </label>
          {/* Lane B (B5): archived runs are hidden by default. */}
          <label className="flex items-center gap-1 text-label text-muted cursor-pointer">
            <Checkbox
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              data-testid="run-show-archived"
            />
            Show archived
          </label>
          <button
            type="button"
            data-testid="run-clear-finished"
            onClick={runClearFinished}
            disabled={bulkBusy}
            className="text-label text-muted hover:text-text disabled:opacity-50 focus-visible:glow-focus rounded-control"
          >
            Clear finished
          </button>
        </div>
      </div>

      {/* Lane B (B5): bulk-action bar, visible once at least one run is selected. */}
      {selectedIds.size > 0 && (
        <div data-testid="run-bulk-bar" className="flex items-center gap-2 px-4 py-2 border-b border-border bg-[var(--glass-panel-bg)]">
          <span className="text-label text-muted mono tabular-nums">{selectedIds.size} selected</span>
          <Button
            size="sm"
            variant="glass"
            data-testid="run-bulk-archive"
            disabled={bulkBusy}
            onClick={runBulkArchiveToggle}
          >
            {allSelectedArchived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="run-bulk-delete"
            disabled={bulkBusy}
            onClick={() => setPendingBulkDelete(true)}
          >
            Delete permanently
          </Button>
          <button
            type="button"
            className="ml-auto text-label text-muted hover:text-text focus-visible:glow-focus rounded-control"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}
      {bulkError && (
        <p data-testid="run-bulk-error" className="px-4 py-1.5 text-label text-red border-b border-border">
          {bulkError}
        </p>
      )}

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-2">
            {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="px-4 py-8">
            {runs.length === 0
              ? <EmptyState icon="runs" headline="No runs yet" hint="⌘K to dispatch one" />
              : <EmptyState icon="runs" headline="No runs match this filter" />}
          </div>
        ) : null}
        {!isLoading && filteredRuns.map(run => {
          const killable = run.status === 'running' || run.status === 'queued'
          return (
            <motion.div key={run.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
              <Row
                testid="run-row" /* intentionally non-unique (one per row): select via getByTestId('run-row').nth(i)/.all() */
                selected={selectedId === run.id}
                onClick={() => onSelect(run.id)}
                leading={
                  <span className="flex items-center gap-1.5">
                    {/* Lane B (B5): bulk-select checkbox, distinct from row-click (opens the run) */}
                    <span onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(run.id)}
                        onChange={() => toggleSelected(run.id)}
                        data-testid={`run-select-${run.id}`}
                      />
                    </span>
                    <StatusPill status={run.status} />
                  </span>
                }
                title={cleanRunPrompt(run.prompt)}
                sub={
                  <span className="flex items-center gap-1.5">
                    <span className="mono tabular-nums">{new Date(run.createdAt).toLocaleTimeString()} · {run.model}</span>
                    {run.archived && (
                      <span data-testid="run-archived-tag"><Tag tint="neutral">archived</Tag></span>
                    )}
                  </span>
                }
                meta={
                  <span className="flex flex-col items-end">
                    <span>${run.costUsd.toFixed(4)}</span>
                    {runDuration(run) && <span data-testid="run-duration">{runDuration(run)}</span>}
                  </span>
                }
                actions={killable ? (
                  <IconButton
                    name="close"
                    label="Kill run"
                    variant="danger"
                    size="sm"
                    onClick={e => { e.stopPropagation(); setPendingKill(run) }}
                    data-testid="run-kill-btn"
                  />
                ) : undefined}
              />
            </motion.div>
          )
        })}
      </div>

      {/* Sticky footer totals */}
      <div className="flex-shrink-0 border-t border-border px-4 py-2">
        <p className="mono tabular-nums text-label text-muted">
          {atLimit && <span className="mr-1">last 100 ·</span>}
          Σ {filteredRuns.length} runs · ${totalCost.toFixed(2)} · {formatTokens(totalTokens)}
        </p>
      </div>

      <ConfirmDialog
        open={pendingKill !== null}
        title="Kill run?"
        testid="run-kill-dialog"
        busy={killing}
        message={
          <>
            Terminating <span className="font-medium text-text">{pendingKill?.prompt}</span>{' '}
            stops the agent immediately. This cannot be undone.
          </>
        }
        confirmLabel="Kill run"
        onConfirm={confirmKill}
        onCancel={() => setPendingKill(null)}
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        title="Delete runs permanently?"
        testid="run-bulk-delete-dialog"
        busy={bulkBusy}
        error={bulkError ?? undefined}
        message={
          <>
            Permanently deleting <span className="font-medium text-text">{selectedIds.size}</span> run(s)
            removes their events, review comments, and plan — this cannot be undone. Only archived,
            non-running runs can be deleted; any others in the selection are skipped.
          </>
        }
        confirmLabel="Delete permanently"
        onConfirm={confirmBulkDelete}
        onCancel={() => { setPendingBulkDelete(false); setBulkError(null) }}
      />
    </div>
  )
}

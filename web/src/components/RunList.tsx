import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import type { Run, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'
import { RUNS_LIST_KEY, RUNS_LIST_LIMIT, runsListQueryFn, isActiveRun, isParkedRun } from '../lib/runs-query'
import { cleanRunPrompt } from '../lib/prompt'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  queued:         'bg-amber/15 text-[var(--amber)]',
  running:        'bg-accent/15 text-[var(--accent-hover)]',
  awaiting_input: 'bg-amber/25 text-[var(--amber)]',
  done:           'bg-green/15 text-[var(--green)]',
  error:          'bg-red/15 text-[var(--red)]',
  killed:         'bg-muted/15 text-[var(--muted)]',
  interrupted:    'bg-red/15 text-[var(--red)]',
}

const STATUS_DOT: Record<string, string> = {
  queued:         'bg-[var(--amber)]',
  running:        'bg-[var(--accent)] glow-live',
  awaiting_input: 'bg-[var(--amber)] glow-live',
  done:           'bg-[var(--green)]',
  error:          'bg-[var(--red)]',
  killed:         'bg-[var(--muted)]',
  interrupted:    'bg-[var(--red)]',
}

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

export default function RunList({ selectedId, onSelect }: Props) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<FilterKey>('all')
  // Run pending kill-confirmation (null = no dialog).
  const [pendingKill, setPendingKill] = useState<Run | null>(null)
  const [killing, setKilling] = useState(false)

  // The shared default-list cache (RunList + ActivityStrip + CommandBar + KHome +
  // Sidebar), live-patched by run_update. Key + fn come from runs-query.ts so the
  // consumers can't drift — a *filtered* or non-default-limit list must use its
  // own scoped queryKey, never this one.
  const { data: runs = [] } = useQuery<Run[]>({
    queryKey: RUNS_LIST_KEY,
    queryFn: runsListQueryFn,
    refetchInterval: 5_000,
  })

  // Live updates via WebSocket — the setQueryData key must be EXACTLY the shared
  // scoped key (a bare ['runs'] prefix would write a different cache entry and the
  // live patch would silently stop reaching the list).
  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update') {
        qc.setQueryData<Run[]>(RUNS_LIST_KEY, old => {
          if (!old) return [msg.run]
          const idx = old.findIndex(r => r.id === msg.run.id)
          if (idx === -1) return [msg.run, ...old]
          const next = [...old]
          next[idx] = msg.run
          return next
        })
      }
    })
  }, [qc])

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

  function handleRowKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">Runs</h2>
        {/* Filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTERS.map(f => {
            const count = countFilter(runs, f)
            const isActive = filter === f
            return (
              <button
                key={f}
                data-testid={`run-filter-${f}`}
                onClick={() => setFilter(f)}
                aria-pressed={isActive}
                className={cn(
                  'text-xs px-2 py-0.5 rounded font-medium transition-colors',
                  isActive
                    ? 'bg-accent/15 text-[var(--accent-hover)]'
                    : 'text-[var(--muted)] hover:text-[var(--text)]'
                )}
              >
                {f} {count}
              </button>
            )
          })}
        </div>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {filteredRuns.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
            {runs.length === 0
              ? (<>No runs yet.<br />Press ⌘K to start one.</>)
              : 'No runs match this filter.'}
          </div>
        )}
        {filteredRuns.map(run => {
          const killable = run.status === 'running' || run.status === 'queued'
          return (
            <motion.div
              key={run.id}
              // intentionally non-unique (one per row): select via getByTestId('run-row').nth(i)/.all()
              data-testid="run-row"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(run.id)}
              onKeyDown={e => handleRowKeyDown(e, run.id)}
              className={cn(
                'group w-full text-left px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors cursor-pointer',
                selectedId === run.id && 'bg-[var(--surface)] border-l-2 border-l-[var(--accent)]'
              )}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', STATUS_DOT[run.status] ?? 'bg-muted')} />
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', STATUS_COLOR[run.status])}>
                  {run.status}
                </span>
                <span className="mono text-xs text-[var(--muted)] ml-auto">
                  ${(run.costUsd).toFixed(4)}
                </span>
                {killable && (
                  <button
                    onClick={e => { e.stopPropagation(); setPendingKill(run) }}
                    data-testid="run-kill-btn"
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-xs px-1.5 py-0.5 rounded bg-red/20 text-[var(--red)] hover:bg-red/30 transition-opacity"
                    aria-label="Kill run"
                  >
                    ✕
                  </button>
                )}
              </div>
              <p className="text-sm text-[var(--text)] truncate">{cleanRunPrompt(run.prompt)}</p>
              <p className="mono text-xs text-[var(--muted)] mt-0.5">
                {new Date(run.createdAt).toLocaleTimeString()} · {run.model}
              </p>
            </motion.div>
          )
        })}
      </div>

      {/* Sticky footer totals */}
      <div className="flex-shrink-0 border-t border-[var(--border)] px-4 py-2">
        <p className="mono text-xs text-[var(--muted)]">
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
            Terminating <span className="font-medium text-[var(--text)]">{pendingKill?.prompt}</span>{' '}
            stops the agent immediately. This cannot be undone.
          </>
        }
        confirmLabel="Kill run"
        onConfirm={confirmKill}
        onCancel={() => setPendingKill(null)}
      />
    </div>
  )
}

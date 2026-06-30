import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { relativeTime } from '../lib/verify'
import Toast from '../components/Toast'
import {
  formatPct,
  formatScore,
  formatCost,
  runProgress,
  discriminationStatus,
  regressionBadge,
  runStatusColor,
  detPassGlyph,
  type EvalSystemRow,
  type EvalRunSummary,
  type SystemMetrics,
  type BaselineCompare,
  type EvalResultRow,
} from '../lib/evals'

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {label}
    </span>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EvalsPage() {
  const qc = useQueryClient()
  const { data: systems = [], isLoading: systemsLoading } = useQuery<EvalSystemRow[]>({
    queryKey: ['evals', 'systems'],
    queryFn: api.evals.systems,
  })
  const { data: runs = [], isLoading: runsLoading } = useQuery<EvalRunSummary[]>({
    queryKey: ['evals', 'runs'],
    queryFn: api.evals.runs,
    refetchInterval: 5_000, // a launched run fills in jobs/cost over time
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [started, setStarted] = useState<string | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  const startMutation = useMutation({
    mutationFn: (body: { systems?: string[]; dry: boolean }) => api.evals.start(body),
    onSuccess: res => {
      setStarted(res.evalRunId)
      setDialogOpen(false)
      qc.invalidateQueries({ queryKey: ['evals', 'runs'] })
    },
  })

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Evals · {systems.length} systems
        </h2>
        <button
          onClick={() => { startMutation.reset(); setDialogOpen(true) }}
          data-testid="evals-open-run"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity duration-150 hover:opacity-90"
        >
          ▶ Run evals
        </button>
      </div>

      <p className="mt-2 text-xs text-[var(--muted)]">
        A <span className="font-medium text-[var(--text)]">real run spends tokens</span> and is gated
        behind an explicit toggle. Dry runs fabricate results and are free.
      </p>

      {/* Systems */}
      <section className="mt-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Systems
        </h3>
        <div className="flex flex-col gap-2">
          {systemsLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
          {!systemsLoading && systems.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No eval systems seeded yet.</p>
          )}
          {systems.map(s => (
            <div
              key={s.id}
              data-testid={`evals-system-${s.id}`}
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-[var(--text)]">{s.title}</span>
                  <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                    {s.id}
                  </span>
                  {!s.enabled && <Badge label="disabled" className="bg-[var(--raised)] text-[var(--muted)]" />}
                </div>
                {s.job && s.job !== s.title && (
                  <p className="mt-0.5 truncate text-xs text-[var(--muted)]">{s.job}</p>
                )}
              </div>
              <span className="flex-shrink-0 text-xs text-[var(--muted)]">{s.caseCount} cases</span>
            </div>
          ))}
        </div>
      </section>

      {/* Runs */}
      <section className="mt-6">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Runs
        </h3>
        <div className="flex flex-col gap-2">
          {runsLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
          {!runsLoading && runs.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No eval runs yet. Start one above.</p>
          )}
          {runs.map(run => (
            <div key={run.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <RunSummaryRow
                run={run}
                expanded={expandedRun === run.id}
                onToggle={() => setExpandedRun(id => (id === run.id ? null : run.id))}
              />
              {expandedRun === run.id && <RunDetail runId={run.id} />}
            </div>
          ))}
        </div>
      </section>

      <RunDialog
        open={dialogOpen}
        systems={systems}
        busy={startMutation.isPending}
        error={startMutation.isError ? (startMutation.error as Error).message : undefined}
        onSubmit={body => startMutation.mutate(body)}
        onClose={() => setDialogOpen(false)}
      />

      <Toast
        open={started !== null}
        testid="evals-started-toast"
        message="Eval run started"
        action={{
          label: 'View run →',
          testid: 'evals-started-toast-link',
          onClick: () => { if (started) { setExpandedRun(started); setStarted(null) } },
        }}
        onDismiss={() => setStarted(null)}
      />
    </div>
  )
}

// ─── Run dialog (the gated control) ───────────────────────────────────────────

function RunDialog({
  open,
  systems,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  systems: EvalSystemRow[]
  busy?: boolean
  error?: string
  onSubmit: (body: { systems?: string[]; dry: boolean }) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [realRun, setRealRun] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Reset to the safe defaults (no selection = all systems; DRY) each time the dialog opens,
  // and move focus into the modal (matches Shell's legend-dialog a11y pattern).
  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setRealRun(false)
      dialogRef.current?.focus()
    }
  }, [open])

  function submit() {
    if (busy) return
    const picked = [...selected]
    // dry is sent EXPLICITLY: false only when the operator armed the real-run toggle, true otherwise.
    onSubmit({ systems: picked.length > 0 ? picked : undefined, dry: !realRun })
  }

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function toggleSystem(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Run evals"
            data-testid="evals-run-dialog"
            className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 outline-none"
            initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <h3 className="text-sm font-semibold text-[var(--text)]">Run evals</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Pick systems (none selected = all). Defaults to a free dry run.
            </p>

            <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--raised)] p-2">
              {systems.length === 0 && (
                <p className="px-1 py-1 text-xs text-[var(--muted)]">No systems to select.</p>
              )}
              {systems.map(s => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-[var(--text)] hover:bg-[var(--surface)]"
                >
                  <input
                    type="checkbox"
                    data-testid={`evals-system-check-${s.id}`}
                    checked={selected.has(s.id)}
                    onChange={() => toggleSystem(s.id)}
                  />
                  <span className="truncate">{s.title}</span>
                  <span className="ml-auto text-[10px] text-[var(--muted)]">{s.caseCount}</span>
                </label>
              ))}
            </div>

            {/* The gated real-run control. DEFAULT = dry. */}
            <label className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text)]">
              <input
                type="checkbox"
                data-testid="evals-real-toggle"
                checked={realRun}
                onChange={e => setRealRun(e.target.checked)}
              />
              <span>
                <span className="font-semibold text-[var(--text)]">Real run — spends tokens</span>{' '}
                <span className="text-[var(--muted)]">(uncheck for a free dry run)</span>
              </span>
            </label>

            {realRun && (
              <p
                data-testid="evals-real-warning"
                className="mt-2 rounded-lg bg-red/15 px-3 py-2 text-xs font-medium text-[var(--red)]"
              >
                ⚠ This will dispatch real agent calls and spend tokens.
              </p>
            )}

            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                data-testid="evals-run-submit"
                className={cn(
                  'rounded-lg px-4 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50',
                  realRun
                    ? 'bg-red/20 text-[var(--red)]'
                    : 'bg-[var(--accent)] text-[var(--bg)]',
                )}
              >
                {busy ? '…' : realRun ? 'Run (spends tokens)' : 'Run dry (free)'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Run summary row (prop-fed, render-testable) ──────────────────────────────

export function RunSummaryRow({
  run,
  expanded,
  onToggle,
}: {
  run: EvalRunSummary
  expanded: boolean
  onToggle: () => void
}) {
  const prog = runProgress(run)
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={`evals-run-row-${run.id}`}
      className="flex w-full items-center gap-3 px-4 py-3 text-left"
    >
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${runStatusColor(run.status)}`}>
        {run.status}
      </span>
      <Badge
        label={run.dry ? 'dry' : 'REAL'}
        className={run.dry ? 'bg-[var(--raised)] text-[var(--muted)]' : 'bg-amber/20 text-[var(--amber)]'}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="mono text-xs text-[var(--muted)]">{prog.label}</span>
        <div className="h-1 w-24 overflow-hidden rounded-full bg-[var(--raised)]">
          <div
            className="h-full rounded-full bg-[var(--accent)]"
            style={{ width: `${Math.round(prog.pct * 100)}%` }}
          />
        </div>
      </div>
      <span className="flex-shrink-0 text-xs text-[var(--muted)]">{formatCost(run.totalCostUsd)}</span>
      <span className="flex-shrink-0 text-[10px] text-[var(--muted)]">{relativeTime(run.createdAt)}</span>
      <span className="flex-shrink-0 text-[10px] text-[var(--accent-hover)]">{expanded ? '▾' : '▸'}</span>
    </button>
  )
}

// ─── Run detail (uses queries) ────────────────────────────────────────────────

function RunDetail({ runId }: { runId: string }) {
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['evals', 'run', runId],
    queryFn: () => api.evals.run(runId),
    refetchInterval: q => (q.state.data?.report ? false : 5_000),
  })
  const compare = useQuery({
    queryKey: ['evals', 'compare', runId],
    queryFn: () => api.evals.compare(runId),
  })
  const results = useQuery({
    queryKey: ['evals', 'results', runId],
    queryFn: () => api.evals.results(runId),
  })

  const [frozen, setFrozen] = useState(false)
  const freezeMutation = useMutation({
    mutationFn: () => api.evals.freezeBaselines(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evals', 'compare', runId] })
      setFrozen(true)
    },
  })

  const report = detail.data?.report ?? null
  const regression: Record<string, BaselineCompare> =
    compare.data ?? report?.regression ?? {}

  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      {/* System metrics */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
            Pass-rate · discrimination · regression
          </h4>
          <button
            onClick={() => freezeMutation.mutate()}
            disabled={freezeMutation.isPending || !report}
            data-testid="evals-freeze-baselines"
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {freezeMutation.isPending ? '…' : '❄ freeze baselines'}
          </button>
        </div>
        {detail.isLoading && <p className="text-xs text-[var(--muted)]">Loading report…</p>}
        {detail.isError && <p className="text-xs text-red-400">Failed to load report.</p>}
        {detail.data && !report && (
          <p className="text-xs text-[var(--muted)]">Report pending — the run is still in progress.</p>
        )}
        {report && <SystemMetricsTable perSystem={report.perSystem} regression={regression} />}
      </div>

      {/* Raw results */}
      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Results
        </h4>
        {results.isLoading && <p className="text-xs text-[var(--muted)]">Loading results…</p>}
        {results.isError && <p className="text-xs text-red-400">Failed to load results.</p>}
        {results.data && <EvalResultsTable rows={results.data} />}
      </div>

      {frozen && (
        <Toast
          open={frozen}
          testid="evals-frozen-toast"
          message="Baselines frozen"
          onDismiss={() => setFrozen(false)}
        />
      )}
    </div>
  )
}

// ─── System metrics table (prop-fed, render-testable) ─────────────────────────

export function SystemMetricsTable({
  perSystem,
  regression,
}: {
  perSystem: Record<string, SystemMetrics>
  regression: Record<string, BaselineCompare>
}) {
  const ids = Object.keys(perSystem)
  if (ids.length === 0) {
    return <p data-testid="evals-metrics-empty" className="text-xs text-[var(--muted)]">No per-system metrics.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table data-testid="evals-metrics-table" className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
            <th className="px-3 py-2 font-medium">System</th>
            <th className="px-3 py-2 font-medium">real judge</th>
            <th className="px-3 py-2 font-medium">real det</th>
            <th className="px-3 py-2 font-medium">degraded det</th>
            <th className="px-3 py-2 font-medium">disc judge</th>
            <th className="px-3 py-2 font-medium">discrimination</th>
            <th className="px-3 py-2 font-medium">regression</th>
          </tr>
        </thead>
        <tbody>
          {ids.map(sysId => {
            const m = perSystem[sysId]
            const disc = discriminationStatus(m.discriminationPass)
            const reg = regressionBadge(regression[sysId])
            return (
              <tr
                key={sysId}
                data-testid={`evals-metric-row-${sysId}`}
                className="border-b border-[var(--border)] last:border-0"
              >
                <td className="px-3 py-2 font-medium text-[var(--text)]">{sysId}</td>
                <td className="px-3 py-2 text-[var(--text)]">{formatScore(m.real.judgeMean)}</td>
                <td className="px-3 py-2 text-[var(--text)]">{formatPct(m.real.detPassRate)}</td>
                <td className="px-3 py-2 text-[var(--muted)]">{formatPct(m.degraded.detPassRate)}</td>
                <td className="px-3 py-2 text-[var(--text)]">{formatScore(m.discriminationJudge)}</td>
                <td className={`px-3 py-2 font-semibold ${disc.colorClass}`}>{disc.label}</td>
                <td className="px-3 py-2">
                  <Badge label={reg.label} className={reg.colorClass} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Eval results table (prop-fed, render-testable) ───────────────────────────

export function EvalResultsTable({ rows }: { rows: EvalResultRow[] }) {
  if (rows.length === 0) {
    return <p data-testid="evals-results-empty" className="text-xs text-[var(--muted)]">No results.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table data-testid="evals-results-table" className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
            <th className="px-3 py-2 font-medium">System · case</th>
            <th className="px-3 py-2 font-medium">model</th>
            <th className="px-3 py-2 font-medium">variant</th>
            <th className="px-3 py-2 font-medium">det</th>
            <th className="px-3 py-2 font-medium">det score</th>
            <th className="px-3 py-2 font-medium">judge</th>
            <th className="px-3 py-2 font-medium">cost</th>
            <th className="px-3 py-2 font-medium">turns</th>
            <th className="px-3 py-2 font-medium">error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              data-testid={`evals-result-row-${r.id}`}
              className="border-b border-[var(--border)] last:border-0"
            >
              <td className="px-3 py-2 text-[var(--text)]">
                <span className="font-medium">{r.systemId}</span>
                <span className="text-[var(--muted)]"> · {r.caseId}</span>
              </td>
              <td className="px-3 py-2 mono text-[var(--muted)]">{r.model}</td>
              <td className="px-3 py-2">
                <Badge
                  label={r.variant}
                  className={
                    r.variant === 'degraded'
                      ? 'bg-amber/20 text-[var(--amber)]'
                      : 'bg-[var(--raised)] text-[var(--muted)]'
                  }
                />
              </td>
              <td className="px-3 py-2 text-[var(--text)]">{detPassGlyph(r.detPass)}</td>
              <td className="px-3 py-2 text-[var(--text)]">{formatScore(r.detScore)}</td>
              <td className="px-3 py-2 text-[var(--text)]">{formatScore(r.judgeOverall)}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{formatCost(r.costUsd)}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{r.numTurns ?? '—'}</td>
              <td
                data-testid={r.error ? `evals-result-error-${r.id}` : undefined}
                className="px-3 py-2 text-red-400"
              >
                {r.error ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

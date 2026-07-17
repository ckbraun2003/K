import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/verify'
import { useFocusTrap } from '../../lib/useFocusTrap'
import Toast from '../../components/Toast'
import { GlassPanel } from '../../ui/GlassPanel'
import { StatusPill } from '../../ui/StatusPill'
import { Skeleton, SkeletonRow } from '../../ui/Skeleton'
import { EmptyState } from '../../ui/EmptyState'
import { Checkbox } from '../../ui/Field'
import {
  formatPct,
  formatScore,
  formatCost,
  runProgress,
  resultTally,
  discriminationStatus,
  regressionBadge,
  runStatusColor,
  detPassGlyph,
  type EvalSystemRow,
  type EvalRunSummary,
  type SystemMetrics,
  type BaselineCompare,
  type EvalResultRow,
} from '../../lib/evals'

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {label}
    </span>
  )
}

// The eval-run status domain is a SUBSET of RunStatus (queued/running/awaiting_input/
// awaiting_plan/done/error/killed/interrupted, per lib/evals.ts's KNOWN_RUN_STATUSES) — every
// member is covered by StatusPill's canonical map. Guarded defensively so a future unknown eval
// status degrades to the existing raw-colored badge instead of StatusPill's silent 'idle' fallback.
const STATUS_PILL_KNOWN = new Set([
  'queued', 'running', 'awaiting_input', 'awaiting_plan', 'done', 'error', 'killed', 'interrupted',
])

// ─── Tab ───────────────────────────────────────────────────────────────────────

export default function EvalsTab() {
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
    <>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="micro-label">
          Evals · <span className="mono tabular-nums">{systems.length}</span> systems
        </h2>
        <button
          onClick={() => { startMutation.reset(); setDialogOpen(true) }}
          data-testid="evals-open-run"
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-opacity duration-150 hover:opacity-90"
        >
          ▶ Run evals
        </button>
      </div>

      <p className="mt-2 text-caption text-muted">
        A <span className="font-medium text-text">real run spends tokens</span> and is gated
        behind an explicit toggle. Dry runs fabricate results and are free.
      </p>

      {/* Systems */}
      <section className="mt-4">
        <h3 className="micro-label mb-2">
          Systems
        </h3>
        <div className="flex flex-col gap-2">
          {systemsLoading && (
            <GlassPanel tier="solid" className="px-4 py-1">
              <SkeletonRow />
              <SkeletonRow />
            </GlassPanel>
          )}
          {!systemsLoading && systems.length === 0 && (
            <EmptyState icon="insights" headline="No eval systems seeded yet." />
          )}
          {systems.map(s => (
            <GlassPanel
              key={s.id}
              tier="solid"
              data-testid={`evals-system-${s.id}`}
              className="flex items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-body font-medium text-text">{s.title}</span>
                  <span className="mono rounded bg-raised px-1.5 py-0.5 text-micro text-muted">
                    {s.id}
                  </span>
                  {!s.enabled && <Badge label="disabled" className="bg-raised text-muted" />}
                </div>
                {s.job && s.job !== s.title && (
                  <p className="mt-0.5 truncate text-caption text-muted">{s.job}</p>
                )}
              </div>
              <span className="flex-shrink-0 text-caption text-muted"><span className="mono tabular-nums">{s.caseCount}</span> cases</span>
            </GlassPanel>
          ))}
        </div>
      </section>

      {/* Runs */}
      <section className="mt-6">
        <h3 className="micro-label mb-2">
          Runs
        </h3>
        <div className="flex flex-col gap-2">
          {runsLoading && (
            <GlassPanel tier="solid" className="px-4 py-1">
              <SkeletonRow />
              <SkeletonRow />
            </GlassPanel>
          )}
          {!runsLoading && runs.length === 0 && (
            <EmptyState
              icon="insights"
              headline="No eval runs yet."
              hint="Start one above."
              cta={{ label: 'Start an eval run', onClick: () => { startMutation.reset(); setDialogOpen(true) } }}
            />
          )}
          {runs.map(run => (
            <GlassPanel key={run.id} tier="solid">
              <RunSummaryRow
                run={run}
                expanded={expandedRun === run.id}
                onToggle={() => setExpandedRun(id => (id === run.id ? null : run.id))}
              />
              {expandedRun === run.id && <RunDetail runId={run.id} dry={run.dry} />}
            </GlassPanel>
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
    </>
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

  // a11y: keep Tab/Shift+Tab cycling inside the modal while it's open.
  useFocusTrap(dialogRef, open)

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
            className="relative w-full max-w-md glass-overlay p-5 outline-none"
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
                  <Checkbox
                    data-testid={`evals-system-check-${s.id}`}
                    checked={selected.has(s.id)}
                    onChange={() => toggleSystem(s.id)}
                  />
                  <span className="truncate">{s.title}</span>
                  <span className="mono tabular-nums ml-auto text-micro text-muted">{s.caseCount}</span>
                </label>
              ))}
            </div>

            {/* The gated real-run control. DEFAULT = dry. */}
            <label className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text)]">
              <Checkbox
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

            {error && <p className="mt-3 text-xs text-red">{error}</p>}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-text"
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
                    ? 'bg-red/20 text-red'
                    : 'bg-accent text-on-accent',
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
      {STATUS_PILL_KNOWN.has(run.status) ? (
        <StatusPill status={run.status} />
      ) : (
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${runStatusColor(run.status)}`}>
          {run.status}
        </span>
      )}
      <Badge
        label={run.dry ? 'dry' : 'REAL'}
        className={run.dry ? 'bg-raised text-muted' : 'bg-amber/20 text-[var(--amber)]'}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Label the count as JOBS DONE, not a pass ratio — "N/N" is completion, not all-green (F-044).
            The honest pass/fail tally lives in the expanded Results section below. */}
        <span className="text-caption text-muted"><span className="mono tabular-nums">{prog.label}</span> jobs</span>
        <div className="h-1 w-24 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.round(prog.pct * 100)}%` }}
          />
        </div>
      </div>
      <span className="mono tabular-nums flex-shrink-0 text-caption text-muted">{formatCost(run.totalCostUsd)}</span>
      <span className="mono flex-shrink-0 text-micro text-muted">{relativeTime(run.createdAt)}</span>
      <span className="flex-shrink-0 text-micro text-accent-hover">{expanded ? '▾' : '▸'}</span>
    </button>
  )
}

// ─── Freeze-baselines button (prop-fed, render-testable) ──────────────────────

/** The freeze control is DISABLED for a dry run: a dry run's metrics are fabricated, so freezing them
 *  as baselines would poison every later real regression comparison (mirrors the service/route 400). */
export function FreezeBaselinesButton({
  dry,
  disabled,
  pending,
  onFreeze,
}: {
  dry: boolean
  disabled: boolean
  pending: boolean
  onFreeze: () => void
}) {
  return (
    <button
      onClick={onFreeze}
      disabled={disabled || dry}
      data-testid="evals-freeze-baselines"
      title={dry ? 'Dry runs fabricate results — freezing them would poison real baselines' : undefined}
      className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
    >
      {pending ? '…' : '❄ freeze baselines'}
    </button>
  )
}

// ─── Run detail (uses queries) ────────────────────────────────────────────────

function RunDetail({ runId, dry }: { runId: string; dry: boolean }) {
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['evals', 'run', runId],
    queryFn: () => api.evals.run(runId),
    refetchInterval: q => (q.state.data?.report ? false : 5_000),
  })
  const compare = useQuery({
    queryKey: ['evals', 'compare', runId],
    queryFn: () => api.evals.compare(runId),
    // A dry run neutralizes regression in the report (all 'dry') and never uses this result — skip the
    // useless network round-trip entirely. (F-025)
    enabled: !dry,
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
  // For a DRY run, use the report's neutral 'dry' statuses and DON'T fall through to the compare
  // endpoint (which re-diffs the fabricated metrics against real baselines → a bogus REGRESSION). The
  // non-dry path still prefers the live compare query. (F-025)
  const regression: Record<string, BaselineCompare> = report?.dry
    ? (report.regression ?? {})
    : (compare.data ?? report?.regression ?? {})

  return (
    <div className="border-t border-border px-4 py-3">
      {/* System metrics */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="micro-label">
            Pass-rate · discrimination · regression
          </h4>
          <FreezeBaselinesButton
            dry={!!report?.dry}
            disabled={freezeMutation.isPending || !report}
            pending={freezeMutation.isPending}
            onFreeze={() => freezeMutation.mutate()}
          />
        </div>
        {detail.isLoading && <Skeleton className="h-24 w-full rounded-control" />}
        {detail.isError && <p className="text-xs text-red">Failed to load report.</p>}
        {detail.data && !report && (
          <p className="text-xs text-muted">Report pending — the run is still in progress.</p>
        )}
        {report && <SystemMetricsTable perSystem={report.perSystem} regression={regression} />}
      </div>

      {/* Raw results */}
      <div>
        <h4 className="micro-label mb-2">
          Results
        </h4>
        {results.isLoading && <Skeleton className="h-24 w-full rounded-control" />}
        {results.isError && <p className="text-xs text-red">Failed to load results.</p>}
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
    return (
      <div data-testid="evals-metrics-empty">
        <EmptyState icon="insights" headline="No per-system metrics." hint="Metrics land here once an eval run completes." />
      </div>
    )
  }
  return (
    <GlassPanel tier="solid" className="overflow-x-auto">
      <table data-testid="evals-metrics-table" className="w-full text-caption">
        <thead>
          <tr className="micro-label border-b border-border [&>th]:font-medium">
            <th className="px-3 py-2 text-left">System</th>
            <th className="px-3 py-2 text-left">real judge</th>
            <th className="px-3 py-2 text-left">real det</th>
            <th className="px-3 py-2 text-left">degraded det</th>
            <th className="px-3 py-2 text-left">disc judge</th>
            <th className="px-3 py-2 text-left">discrimination</th>
            <th className="px-3 py-2 text-left">regression</th>
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
                className="border-b border-border last:border-0"
              >
                <td className="px-3 py-2 font-medium text-text">{sysId}</td>
                <td className="mono tabular-nums px-3 py-2 text-text">{formatScore(m.real.judgeMean)}</td>
                <td className="mono tabular-nums px-3 py-2 text-text">{formatPct(m.real.detPassRate)}</td>
                <td className="mono tabular-nums px-3 py-2 text-muted">{formatPct(m.degraded.detPassRate)}</td>
                <td className="mono tabular-nums px-3 py-2 text-text">{formatScore(m.discriminationJudge)}</td>
                <td className={`px-3 py-2 font-semibold ${disc.colorClass}`}>{disc.label}</td>
                <td className="px-3 py-2">
                  <Badge label={reg.label} className={reg.colorClass} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </GlassPanel>
  )
}

// ─── Eval results table (prop-fed, render-testable) ───────────────────────────

export function EvalResultsTable({ rows }: { rows: EvalResultRow[] }) {
  if (rows.length === 0) {
    return (
      <div data-testid="evals-results-empty">
        <EmptyState icon="insights" headline="No results." hint="Case-level results land here once this run completes." />
      </div>
    )
  }
  // Honest pass/fail tally — distinguishes PASSED from merely COMPLETED (the run-row "N/N" count) so a
  // run with failures no longer reads as all-green (F-044).
  const tally = resultTally(rows)
  return (
    <GlassPanel tier="solid" className="overflow-x-auto">
      <div
        data-testid="evals-results-tally"
        className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-caption"
      >
        <span className="font-semibold text-green"><span className="mono tabular-nums">{tally.passed}</span> passed</span>
        {tally.failed > 0 && (
          <span className="font-semibold text-red">· <span className="mono tabular-nums">{tally.failed}</span> failed</span>
        )}
        <span className="text-muted">· <span className="mono tabular-nums">{tally.total}</span> total</span>
      </div>
      <table data-testid="evals-results-table" className="w-full text-caption">
        <thead>
          <tr className="micro-label border-b border-border [&>th]:font-medium">
            <th className="px-3 py-2 text-left">System · case</th>
            <th className="px-3 py-2 text-left">model</th>
            <th className="px-3 py-2 text-left">variant</th>
            <th className="px-3 py-2 text-left">det</th>
            <th className="px-3 py-2 text-left">det score</th>
            <th className="px-3 py-2 text-left">judge</th>
            <th className="px-3 py-2 text-left">cost</th>
            <th className="px-3 py-2 text-left">turns</th>
            <th className="px-3 py-2 text-left">error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              data-testid={`evals-result-row-${r.id}`}
              className="border-b border-border last:border-0"
            >
              <td className="px-3 py-2 text-text">
                <span className="font-medium">{r.systemId}</span>
                <span className="text-muted"> · {r.caseId}</span>
              </td>
              <td className="px-3 py-2 mono text-muted">{r.model}</td>
              <td className="px-3 py-2">
                <Badge
                  label={r.variant}
                  className={
                    r.variant === 'degraded'
                      ? 'bg-amber/20 text-[var(--amber)]'
                      : 'bg-raised text-muted'
                  }
                />
              </td>
              <td className="px-3 py-2 text-text">{detPassGlyph(r.detPass)}</td>
              <td className="mono tabular-nums px-3 py-2 text-text">{formatScore(r.detScore)}</td>
              <td className="mono tabular-nums px-3 py-2 text-text">{formatScore(r.judgeOverall)}</td>
              <td className="mono tabular-nums px-3 py-2 text-muted">{formatCost(r.costUsd)}</td>
              <td className="mono tabular-nums px-3 py-2 text-muted">{r.numTurns ?? '—'}</td>
              <td
                data-testid={r.error ? `evals-result-error-${r.id}` : undefined}
                className="px-3 py-2 text-red"
              >
                {r.error ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  )
}

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { Project, VerificationReport, VerifyRecipe, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import ConfirmDialog from '../components/ConfirmDialog'
import {
  groupFindings,
  barPct,
  formatTimeAgo,
  latestReport,
  trendIndicator,
  scoreColor,
  BREAKDOWN_BARS,
  BREAKDOWN_MAX,
  SEVERITY_DOT,
} from '../lib/verify'

export default function ProjectVerification({ projectId }: { projectId?: string }) {
  const qc = useQueryClient()

  const { data: projects = [], isSuccess: projectsLoaded } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  })
  const project = projects.find(p => p.id === projectId)
  // Distinguish "still loading the fleet" from "loaded, but no such project".
  const projectName = project?.name ?? (projectsLoaded ? 'Project not found' : 'Project')

  const { data: reports = [], isLoading } = useQuery<VerificationReport[]>({
    queryKey: ['verifications', projectId],
    queryFn: () => api.projects.verifications(projectId!),
    enabled: !!projectId,
  })
  const latest = latestReport(reports)

  // Live: when a verification_update arrives for THIS project, refresh the
  // report list + the projects list (healthScore/lastVerifiedAt move with it).
  useEffect(() => {
    if (!projectId) return
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'verification_update' && msg.report.projectId === projectId) {
        qc.invalidateQueries({ queryKey: ['verifications', projectId] })
        qc.invalidateQueries({ queryKey: ['projects'] })
      }
    })
  }, [qc, projectId])

  const reRun = useMutation({
    mutationFn: () => api.projects.verify(projectId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const deepVerify = useMutation({
    mutationFn: () => api.projects.verify(projectId!, { deep: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const pending = reRun.isPending || deepVerify.isPending
  const error = reRun.error ?? deepVerify.error

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        No project selected.
      </div>
    )
  }

  const grouped = latest ? groupFindings(latest.findings) : []

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('projects')}
          className="text-xs text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
          aria-label="Back to projects"
        >
          ← Fleet
        </button>
        <h2 className="text-sm font-semibold text-[var(--text)]">
          {projectName}
        </h2>
        {project?.healthScore != null && (
          <span className={cn('mono ml-1 text-xs', scoreColor(project.healthScore))}>
            {project.healthScore}/100
          </span>
        )}
        <span className="ml-auto text-[11px] text-[var(--muted)]">
          {formatTimeAgo(project?.lastVerifiedAt)}
        </span>
      </div>

      {/* Actions */}
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => reRun.mutate()}
          disabled={pending}
          data-testid="verify-rerun"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
        >
          {reRun.isPending ? 'verifying…' : '▶ Re-run'}
        </button>
        <button
          onClick={() => deepVerify.mutate()}
          disabled={pending}
          data-testid="verify-deep"
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors duration-150 hover:border-[var(--accent)] disabled:opacity-40"
        >
          {deepVerify.isPending ? 'dispatching…' : 'Deep verify'}
        </button>
        {error && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(error)}</span>
        )}
      </div>

      {isLoading ? (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading reports…</p>
      ) : !latest ? (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">
          No verification reports yet. Run a verification to score this project.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          {/* Left column: score + breakdown + findings + fixes */}
          <div className="space-y-5">
            {/* Score + breakdown */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-baseline gap-3">
                <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                  {latest.score ?? '—'}
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {latest.score == null ? 'insufficient signal' : '/ 100 health'}
                </span>
              </div>

              {latest.breakdown ? (() => {
                const bd = latest.breakdown // narrowed: defined inside this block
                return (
                <div className="mt-4 space-y-2.5">
                  {BREAKDOWN_BARS.map(({ key, label }) => {
                    const value = bd[key]
                    const max = BREAKDOWN_MAX[key]
                    const pct = barPct(value, max)
                    return (
                      <div key={key} data-testid={`bar-${key}`}>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-[var(--muted)]">{label}</span>
                          <span className="mono text-[var(--muted)]">
                            {value == null ? 'not measured' : `${value}/${max}`}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
                          <motion.div
                            className="h-full rounded-full bg-[var(--accent)]"
                            initial={{ width: 0 }}
                            animate={{ width: `${pct * 100}%` }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
                )
              })() : (
                <p className="mt-3 text-[11px] text-[var(--muted)]">
                  No score breakdown on this report.
                </p>
              )}
            </div>

            {/* Findings */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Findings
              </h3>
              {grouped.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--muted)]">No findings — clean report.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {grouped.map(group =>
                    group.items.map(f => (
                      <div key={`${group.severity}-${f.area}-${f.message}`} className="flex items-start gap-2">
                        <span
                          className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', SEVERITY_DOT[group.severity])}
                        />
                        <p className="text-xs text-[var(--text)]">
                          <span className="mono text-[var(--muted)]">{f.area}</span>
                          {' · '}
                          {f.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Fixes applied */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Fixes applied
              </h3>
              {latest.fixesApplied.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--muted)]">No fixes applied this run.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {latest.fixesApplied.map((fix, i) => (
                    <li key={`${i}-${fix}`} className="flex items-start gap-2 text-xs text-[var(--text)]">
                      <span className="text-[var(--green)]">✓</span>
                      {fix}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right column: history timeline */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
              History
            </h3>
            <ol className="mt-3 space-y-2">
              {[...reports]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(r => {
                  const trend = trendIndicator(reports, r.id)
                  const trendColor = trend.includes('▲')
                    ? 'text-[var(--green)]'
                    : trend.includes('▼')
                      ? 'text-[var(--red)]'
                      : 'text-[var(--muted)]'
                  return (
                    <li key={r.id} className="flex items-center gap-2 text-xs">
                      <span className={cn('mono font-semibold', scoreColor(r.score))}>{r.score ?? '—'}</span>
                      <span className={cn('mono text-[10px]', trendColor)}>{trend}</span>
                      <span className="text-[var(--muted)]">{formatTimeAgo(r.startedAt)}</span>
                      {r.id === latest.id && (
                        <span className="ml-auto text-[10px] text-[var(--accent)]">latest</span>
                      )}
                    </li>
                  )
                })}
            </ol>
          </div>
        </div>
      )}

      {/* Recipe editor — E-04: the ordered gate commands the verify runner
          executes after each run for this project. Keyed by project id so a
          project switch reseeds the draft rows. */}
      {project && <VerifyRecipeCard key={project.id} project={project} />}
    </div>
  )
}

/**
 * VerifyRecipeCard (E-04, P1 Task 9/B2) — per-project verify recipe editor.
 * Rows of {label, run} seeded from project.verifyRecipe (the ['projects']
 * cache), add/remove rows, ONE recipe-level timeoutMs (per-recipe, NOT
 * per-command), Save → PATCH the recipe, Clear → ConfirmDialog then PATCH
 * null. Seeds ONCE via useState initializers (the parent keys this component
 * by project id) so a background ['projects'] refetch never clobbers edits.
 */
// Stable per-row identity for React keys: index keys would make a focused
// input silently adopt a NEIGHBOR row's content when an earlier row is removed.
type EditorRow = { id: number; label: string; run: string }
let rowSeq = 0
const newEditorRow = (label = '', run = ''): EditorRow => ({ id: ++rowSeq, label, run })

export function VerifyRecipeCard({ project }: { project: Project }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<EditorRow[]>(
    () => project.verifyRecipe?.commands.map(c => newEditorRow(c.label, c.run)) ?? [],
  )
  const [timeoutMs, setTimeoutMs] = useState<string>(() =>
    project.verifyRecipe?.timeoutMs != null ? String(project.verifyRecipe.timeoutMs) : '',
  )
  const [confirmClear, setConfirmClear] = useState(false)

  const save = useMutation({
    mutationFn: (recipe: VerifyRecipe | null) => api.projects.setVerifyRecipe(project.id, recipe),
    onSuccess: (_saved, recipe) => {
      if (recipe === null) {
        setRows([])
        setTimeoutMs('')
      }
      setConfirmClear(false)
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const setRow = (id: number, patch: Partial<Pick<EditorRow, 'label' | 'run'>>) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))

  const rowsValid = rows.length > 0 && rows.every(r => r.label.trim() !== '' && r.run.trim() !== '')
  const timeout = timeoutMs.trim() === '' ? undefined : Number(timeoutMs)
  const timeoutValid = timeout === undefined || (Number.isInteger(timeout) && timeout > 0)

  const buildRecipe = (): VerifyRecipe => ({
    commands: rows.map(r => ({ label: r.label.trim(), run: r.run.trim() })),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
  })

  return (
    <div
      className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
      data-testid="verify-recipe-card"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Verify recipe
        </h3>
        {project.verifyRecipe ? (
          <span className="rounded bg-green/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--green)]">
            {project.verifyRecipe.commands.length} gate{project.verifyRecipe.commands.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="rounded border border-[var(--border)] bg-[var(--raised)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)]">
            none
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 space-y-2">
          {rows.map((row, i) => (
            <div key={row.id} className="flex items-center gap-2">
              <input
                value={row.label}
                onChange={e => setRow(row.id, { label: e.target.value })}
                placeholder="label"
                data-testid={`recipe-label-${i}`}
                className="w-36 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
              <input
                value={row.run}
                onChange={e => setRow(row.id, { run: e.target.value })}
                placeholder="command"
                data-testid={`recipe-run-${i}`}
                className="mono min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
              <button
                onClick={() => setRows(rs => rs.filter(r => r.id !== row.id))}
                aria-label={`Remove ${row.label || 'command'}`}
                data-testid={`recipe-remove-${i}`}
                className="rounded px-1.5 py-1 text-xs text-[var(--muted)] transition-colors hover:text-[var(--red)]"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setRows(rs => [...rs, newEditorRow()])}
          data-testid="recipe-add-row"
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)]"
        >
          + Add command
        </button>
        <input
          value={timeoutMs}
          onChange={e => setTimeoutMs(e.target.value)}
          placeholder="timeout ms"
          inputMode="numeric"
          aria-label="Recipe timeout in milliseconds"
          data-testid="recipe-timeout"
          className={cn(
            'w-28 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]',
            !timeoutValid && 'border-[var(--red)]',
          )}
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => save.mutate(buildRecipe())}
            disabled={!rowsValid || !timeoutValid || save.isPending}
            data-testid="recipe-save"
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            {save.isPending ? 'saving…' : 'Save'}
          </button>
          <button
            onClick={() => setConfirmClear(true)}
            disabled={!project.verifyRecipe || save.isPending}
            data-testid="recipe-clear"
            className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--muted)] transition-colors hover:text-[var(--red)] disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>
      {save.error && (
        <p className="mt-2 text-[11px] text-[var(--red)]">⚠ {String(save.error)}</p>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear verify recipe?"
        message={<>Removes every gate command from <span className="font-semibold text-[var(--text)]">{project.name}</span> — its runs will no longer be verified.</>}
        confirmLabel="Clear recipe"
        testid="recipe-clear-confirm"
        busy={save.isPending}
        error={save.error ? String(save.error) : undefined}
        onConfirm={() => save.mutate(null)}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}

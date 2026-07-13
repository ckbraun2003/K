import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { Project, VerificationReport, VerifyRecipe, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import ConfirmDialog from '../components/ConfirmDialog'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { Button, IconButton } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Tag } from '../ui/Tag'
import { Input } from '../ui/Field'
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
  // `const` narrows through the .map() closure below; `latest.breakdown` (a
  // property access) would not — TS can't prove a nested function won't see
  // it become undefined between checks.
  const breakdown = latest?.breakdown

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          icon="arrowLeft"
          aria-label="Back to projects"
          onClick={() => navigate('projects')}
        >
          Fleet
        </Button>
        <h2 className="text-title text-text">
          {projectName}
        </h2>
        {project?.healthScore != null && (
          <span className={cn('mono ml-1 text-xs', scoreColor(project.healthScore))}>
            {project.healthScore}/100
          </span>
        )}
        <span className="ml-auto text-caption text-muted">
          {formatTimeAgo(project?.lastVerifiedAt)}
        </span>
      </div>

      {/* Actions */}
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="verify-rerun"
          disabled={pending}
          loading={reRun.isPending}
          onClick={() => reRun.mutate()}
        >
          {reRun.isPending ? 'verifying…' : 'Re-run'}
        </Button>
        <Button
          variant="glass"
          size="sm"
          data-testid="verify-deep"
          disabled={pending}
          loading={deepVerify.isPending}
          onClick={() => deepVerify.mutate()}
        >
          {deepVerify.isPending ? 'dispatching…' : 'Deep verify'}
        </Button>
        {error && (
          <span className="inline-flex items-center gap-1 text-caption text-red">
            <Icon name="warning" size={14} className="text-red" />
            {String(error)}
          </span>
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
            <GlassPanel tier="panel" className="p-4">
              <div className="flex items-baseline gap-3">
                <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                  {latest.score ?? '—'}
                </span>
                <span className="text-body text-muted">
                  {latest.score == null ? 'insufficient signal' : '/ 100 health'}
                </span>
              </div>

              {breakdown ? (
                <div className="mt-4 space-y-2.5">
                  {BREAKDOWN_BARS.map(({ key, label }) => {
                    const value = breakdown[key]
                    const max = BREAKDOWN_MAX[key]
                    const pct = barPct(value, max)
                    return (
                      <div key={key} data-testid={`bar-${key}`}>
                        <div className="flex items-center justify-between text-caption">
                          <span className="text-muted">{label}</span>
                          <span className="mono text-muted">
                            {value == null ? 'not measured' : `${value}/${max}`}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                          <motion.div
                            className="h-full rounded-full bg-accent"
                            initial={{ width: 0 }}
                            animate={{ width: `${pct * 100}%` }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-3 text-caption text-muted">
                  No score breakdown on this report.
                </p>
              )}
            </GlassPanel>

            {/* Findings */}
            <GlassPanel tier="panel" className="p-4">
              <SectionHeader label="Findings" />
              {grouped.length === 0 ? (
                <p className="text-caption text-muted">No findings — clean report.</p>
              ) : (
                <div className="space-y-2">
                  {grouped.map(group =>
                    group.items.map(f => (
                      <div key={`${group.severity}-${f.area}-${f.message}`} className="flex items-start gap-2">
                        <span
                          className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', SEVERITY_DOT[group.severity])}
                        />
                        <p className="text-caption text-text">
                          <span className="mono text-muted">{f.area}</span>
                          {' · '}
                          {f.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </GlassPanel>

            {/* Fixes applied */}
            <GlassPanel tier="panel" className="p-4">
              <SectionHeader label="Fixes applied" />
              {latest.fixesApplied.length === 0 ? (
                <p className="text-caption text-muted">No fixes applied this run.</p>
              ) : (
                <ul className="space-y-1.5">
                  {latest.fixesApplied.map((fix, i) => (
                    <li key={`${i}-${fix}`} className="flex items-start gap-2 text-caption text-text">
                      <Icon name="check" size={14} className="text-green" />
                      {fix}
                    </li>
                  ))}
                </ul>
              )}
            </GlassPanel>
          </div>

          {/* Right column: history timeline */}
          <GlassPanel tier="panel" className="p-4">
            <SectionHeader label="History" />
            <ol className="space-y-2">
              {[...reports]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(r => {
                  const trend = trendIndicator(reports, r.id)
                  const trendColor = trend.includes('▲')
                    ? 'text-green'
                    : trend.includes('▼')
                      ? 'text-red'
                      : 'text-muted'
                  return (
                    <li key={r.id} className="flex items-center gap-2 text-caption">
                      <span className={cn('mono font-semibold', scoreColor(r.score))}>{r.score ?? '—'}</span>
                      <span className={cn('mono text-micro', trendColor)}>{trend}</span>
                      <span className="text-muted">{formatTimeAgo(r.startedAt)}</span>
                      {r.id === latest.id && (
                        <span className="ml-auto text-micro text-accent">latest</span>
                      )}
                    </li>
                  )
                })}
            </ol>
          </GlassPanel>
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
    <GlassPanel tier="panel" className="mt-5 p-4" data-testid="verify-recipe-card">
      <div className="flex items-center gap-2">
        <h3 className="micro-label">Verify recipe</h3>
        {project.verifyRecipe ? (
          <Tag tint="accent">
            <span className="mono">{project.verifyRecipe.commands.length}</span>{' '}
            gate{project.verifyRecipe.commands.length === 1 ? '' : 's'}
          </Tag>
        ) : (
          <Tag tint="neutral">none</Tag>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 space-y-2">
          {rows.map((row, i) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                value={row.label}
                onChange={e => setRow(row.id, { label: e.target.value })}
                placeholder="label"
                data-testid={`recipe-label-${i}`}
                className="w-36"
              />
              <Input
                value={row.run}
                onChange={e => setRow(row.id, { run: e.target.value })}
                placeholder="command"
                data-testid={`recipe-run-${i}`}
                className="mono min-w-0 flex-1"
              />
              {/* variant="ghost" — this card is itself a GlassPanel; IconButton's
                  default "glass" variant would nest backdrop-filter inside it. */}
              <IconButton
                name="close"
                label={`Remove ${row.label || 'command'}`}
                variant="ghost"
                onClick={() => setRows(rs => rs.filter(r => r.id !== row.id))}
                data-testid={`recipe-remove-${i}`}
                className="hover:text-red"
              />
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {/* variant="ghost", not "glass" (brief default) — same nested-blur reason
            as the remove button above: this button lives inside this GlassPanel. */}
        <Button
          variant="ghost"
          size="sm"
          icon="plus"
          onClick={() => setRows(rs => [...rs, newEditorRow()])}
          data-testid="recipe-add-row"
        >
          Add command
        </Button>
        <Input
          value={timeoutMs}
          onChange={e => setTimeoutMs(e.target.value)}
          placeholder="timeout ms"
          inputMode="numeric"
          aria-label="Recipe timeout in milliseconds"
          data-testid="recipe-timeout"
          invalid={!timeoutValid}
          className="w-28"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => save.mutate(buildRecipe())}
            disabled={!rowsValid || !timeoutValid || save.isPending}
            loading={save.isPending}
            data-testid="recipe-save"
          >
            {save.isPending ? 'saving…' : 'Save'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={!project.verifyRecipe || save.isPending}
            data-testid="recipe-clear"
          >
            Clear
          </Button>
        </div>
      </div>
      {save.error && (
        <p className="mt-2 inline-flex items-center gap-1 text-caption text-red">
          <Icon name="warning" size={14} className="text-red" />
          {String(save.error)}
        </p>
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
    </GlassPanel>
  )
}

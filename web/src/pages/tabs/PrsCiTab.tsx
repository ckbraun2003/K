import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GithubStatus, PrInfo, CiRunInfo, Project, DiffPayload } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import DiffViewer from '../../components/DiffViewer'
import MergeButton from '../../components/MergeButton'
import { Icon } from '../../ui/Icon'
import { Button, IconButton } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { Input, Textarea, Checkbox } from '../../ui/Field'
import { Tag } from '../../ui/Tag'
import { Row } from '../../ui/Row'

interface Props {
  projectId: string
}

/** GitHub Actions run URL for a CI run, or null when the repo remote is unknown
 *  (CiRunInfo carries no url of its own — we compose the canonical Actions path). */
export function ciRunUrl(remote: string | undefined, runId: number): string | null {
  return remote ? `https://github.com/${remote}/actions/runs/${runId}` : null
}

/** Best-effort default base branch for a new PR (F-047 + W4 follow-up). Prefers the
 *  repo's PERSISTED default branch (detected at register/clone), which is exact.
 *  Pre-migration rows have no persisted branch, so it falls back to the old heuristic:
 *  a repo's CI runs on its default branch, so the most recent CI run whose branch is a
 *  conventional default ('main' or 'master') names it. Falls back to 'main' when no
 *  signal exists. (ci[] is newest-first, so the first match is the freshest.) */
export function defaultBaseBranch(project: Project | undefined, github: GithubStatus | undefined): string {
  if (project?.defaultBranch) return project.defaultBranch
  const hit = github?.ci?.find(r => r.branch === 'main' || r.branch === 'master')
  return hit?.branch ?? 'main'
}

function timeAgo(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs == null) return 'never'
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (Number.isNaN(ts)) return 'unknown'
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

const CHECK_DOT: Record<string, string> = {
  passing: 'bg-green',
  failing:  'bg-red',
  pending:  'bg-amber glow-live',
  none:     'bg-muted',
}

function ciConclusionColor(conclusion: string | null, status: string): string {
  if (status === 'in_progress' || status === 'queued') return 'text-amber'
  if (conclusion === 'success') return 'text-green'
  if (conclusion === 'failure' || conclusion === 'cancelled') return 'text-red'
  return 'text-muted'
}

function ciLabel(run: CiRunInfo): string {
  if (run.status === 'in_progress') return 'in progress'
  if (run.status === 'queued') return 'queued'
  return run.conclusion ?? run.status
}

/** A PR row that expands to a lazily-fetched, read-only side-by-side diff
 *  (`gh pr diff` → the ONE DiffPayload shape). The diff query stays disabled until
 *  the row is first expanded, so an unopened PR costs nothing. The external ↗ anchor
 *  stops propagation so opening GitHub never toggles the panel. */
function PrRow({ pr, projectId }: { pr: PrInfo; projectId: string }) {
  const [expanded, setExpanded] = useState(false)
  const { data: diff, isLoading, error } = useQuery<DiffPayload>({
    queryKey: ['pr-diff', projectId, pr.number],
    queryFn: () => api.projects.prDiff(projectId, pr.number),
    enabled: expanded,
  })
  return (
    <div className="border-b border-border">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid={`pr-row-${pr.number}`}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
        className="flex items-start gap-3 px-4 py-3 hover:bg-surface transition-colors cursor-pointer"
      >
        {/* Expand chevron */}
        <Icon
          name="chevronRight"
          size={14}
          className={cn('mt-1 flex-shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        />

        {/* Check dot */}
        <span className={cn('mt-1 w-2 h-2 rounded-full flex-shrink-0', CHECK_DOT[pr.checks] ?? 'bg-muted')} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="mono text-xs text-muted">#{pr.number}</span>
            <p className="text-sm text-text truncate">{pr.title}</p>
          </div>
          <p className="mono text-[10px] text-muted mt-0.5">checks: {pr.checks}</p>
        </div>

        {/* One-click merge (renders only for OPEN + green PRs) — stops propagation itself */}
        <MergeButton projectId={projectId} pr={pr} />

        {/* External link */}
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title="Open on GitHub"
          className="flex-shrink-0 text-muted hover:text-accent-hover transition-colors mt-0.5"
          aria-label="Open PR on GitHub"
        >
          <Icon name="external" size={14} />
        </a>
      </div>

      {/* Lazily-fetched read-only diff panel */}
      {expanded && (
        <div className="border-t border-border bg-bg">
          {isLoading && (
            <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
              <Spinner size={14} /> Loading diff…
            </p>
          )}
          {error != null && <p className="px-4 py-3 text-xs text-red">{String((error as Error).message)}</p>}
          {diff != null && (
            <div className="overflow-x-auto" data-testid={`pr-diff-${pr.number}`}>
              {diff.files.length === 0
                ? <p className="px-4 py-3 text-xs text-muted">No file changes.</p>
                : <DiffViewer files={diff.files} comments={[]} readOnly />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CiRow({ run, remote }: { run: CiRunInfo; remote?: string }) {
  const color = ciConclusionColor(run.conclusion, run.status)
  const url = ciRunUrl(remote, run.id)
  return (
    <Row
      testid="ci-row"
      leading={<span aria-hidden className={cn('h-2 w-2 flex-shrink-0 rounded-full', color.replace('text-', 'bg-'))} />}
      title={
        <>
          {run.workflow} <span className={cn('mono', color)}>{ciLabel(run)}</span>
        </>
      }
      sub={timeAgo(run.createdAt)}
      meta={<Tag tint="neutral" className="mono">{run.branch}</Tag>}
      /* IN-2: duration column pending CiRunInfo.durationMs from BE — shared/src is frozen this lane. */
      actions={
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            title="Open run on GitHub"
            aria-label={`Open CI run ${run.id} on GitHub`}
            className="mono text-[10px] text-muted flex-shrink-0 hover:text-accent-hover transition-colors inline-flex items-center gap-1"
          >
            #{run.id} <Icon name="external" size={14} />
          </a>
        ) : (
          <span className="mono text-[10px] text-muted flex-shrink-0">#{run.id}</span>
        )
      }
    />
  )
}

const DEFAULT_FORM = { title: '', body: '', head: '', base: 'main' }

export default function PrsCiTab({ projectId }: Props) {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [prForm, setPrForm] = useState<{ title: string; body: string; head: string; base: string }>(DEFAULT_FORM)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [prNumber, setPrNumber] = useState<number | null>(null)

  const { data: github, isLoading, error } = useQuery<GithubStatus>({
    queryKey: ['github', projectId],
    queryFn: () => api.projects.github(projectId),
    refetchInterval: 60_000,
  })

  // The project record — its `githubRemote` gates every PR-creation affordance
  // (F-061: a remoteless project has nowhere to push a PR) and provides the repo
  // slug that linkifies CI runs (F-046). Reads the app-wide cached ['projects'].
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  })
  const project = projects.find(p => p.id === projectId)
  const remote = project?.githubRemote
  const hasRemote = !!remote

  const createPrMutation = useMutation({
    mutationFn: () => api.projects.createPr(projectId, prForm),
    onSuccess: (pr) => {
      void qc.invalidateQueries({ queryKey: ['github', projectId] })
      setPrUrl(pr.url)
      setPrNumber(pr.number)
      setShowModal(false)
      setPrForm(DEFAULT_FORM)
    },
  })

  // E-06 auto-merge toggle — seeded from the cached project record; on toggle it
  // persists via setAutoMerge and re-reads the ['projects'] list the tab holds.
  const autoMergeMutation = useMutation({
    mutationFn: (enabled: boolean) => api.projects.setAutoMerge(projectId, enabled),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['projects'] }) },
  })

  useEffect(() => {
    if (!showModal) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showModal])

  const openPrs = github?.prs.filter(p => p.state === 'OPEN') ?? []
  // Merged/closed PRs were never surfaced (open-only filter): with 0 open PRs the
  // tab had zero PR links at all (F-046). Show them in their own section.
  const closedPrs = github?.prs.filter(p => p.state !== 'OPEN') ?? []
  const ciRuns = github?.ci ?? []

  // Open the Create-PR modal with the base pre-filled to the repo's real default
  // branch (F-047) rather than a hardcoded 'main'.
  function openCreatePr() {
    setPrForm({ ...DEFAULT_FORM, base: defaultBaseBranch(project, github) })
    createPrMutation.reset()
    setShowModal(true)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header bar */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          {hasRemote ? (
            <Button data-testid="prs-open-pr" variant="glass" size="sm" icon="plus" onClick={openCreatePr}>
              Open PR
            </Button>
          ) : (
            <span data-testid="prs-no-remote" className="text-[11px] text-muted">
              No GitHub remote — PRs unavailable
            </span>
          )}
          {/* Auto-merge greens — only meaningful when the project has a remote to push to */}
          {hasRemote && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
              <Checkbox
                data-testid="automerge-toggle"
                checked={!!project?.autoMerge}
                onChange={e => autoMergeMutation.mutate(e.target.checked)}
              />
              Auto-merge greens (k/verify + checks)
            </label>
          )}
        </div>
        <span className="mono text-[10px] text-muted">
          {github?.fetchedAt != null
            ? `Updated ${timeAgo(github.fetchedAt)}`
            : isLoading
            ? 'Loading…'
            : error
            ? 'Fetch failed'
            : 'Never fetched'}
        </span>
      </div>

      {/* Success banner */}
      {prUrl != null && prNumber != null && (
        <div className="flex-shrink-0 px-4 py-2 bg-surface border-b border-border text-xs text-text flex items-center gap-2">
          <span className="text-green">PR created:</span>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-hover underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            #{prNumber}
          </a>
          <IconButton
            name="close"
            variant="ghost"
            label="Dismiss"
            onClick={() => { setPrUrl(null); setPrNumber(null) }}
            className="ml-auto"
          />
        </div>
      )}

      {isLoading && (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted">
          <Spinner size={16} /> Loading GitHub status…
        </div>
      )}

      {error && !isLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-red">
          Failed to load GitHub status: {String(error)}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* PRs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-raised border-b border-border">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Open PRs · <span className="mono">{openPrs.length}</span>
              </h3>
            </div>
            {openPrs.length === 0 ? (
              <div className="px-4 py-4 text-xs text-muted">No open PRs.</div>
            ) : (
              openPrs.map(pr => <PrRow key={pr.number} pr={pr} projectId={projectId} />)
            )}
          </div>

          {/* Merged / closed PRs section (F-046) — only when there are any */}
          {closedPrs.length > 0 && (
            <div className="flex-shrink-0">
              <div className="px-4 py-2 bg-raised border-b border-border">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                  Merged / Closed · <span className="mono">{closedPrs.length}</span>
                </h3>
              </div>
              {closedPrs.map(pr => <PrRow key={pr.number} pr={pr} projectId={projectId} />)}
            </div>
          )}

          {/* CI Runs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-raised border-b border-border">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                CI Runs · <span className="mono">{ciRuns.length}</span>
              </h3>
            </div>
            {ciRuns.length === 0 ? (
              <div className="px-4 py-4 text-xs text-muted">No CI runs.</div>
            ) : (
              ciRuns.map(run => <CiRow key={run.id} run={run} remote={remote} />)
            )}
          </div>
        </>
      )}

      {/* Create PR Modal — never rendered for a remoteless project (F-061) */}
      {showModal && hasRemote && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}
        >
          <div
            className="w-full max-w-md glass-overlay p-6 flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <h2 id="modal-title" className="text-sm font-semibold text-text">Open Pull Request</h2>

            {/* Title */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Title</span>
              <Input
                type="text"
                value={prForm.title}
                onChange={e => setPrForm(f => ({ ...f, title: e.target.value }))}
                placeholder="feat: my change"
                maxLength={255}
              />
            </label>

            {/* Description */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Description</span>
              <Textarea
                value={prForm.body}
                onChange={e => setPrForm(f => ({ ...f, body: e.target.value }))}
                rows={6}
                maxLength={65535}
                placeholder="What does this PR do?"
              />
            </label>

            {/* Head branch */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Head branch</span>
              <Input
                type="text"
                value={prForm.head}
                onChange={e => setPrForm(f => ({ ...f, head: e.target.value }))}
                placeholder="feat/my-branch"
                maxLength={255}
              />
            </label>

            {/* Base branch */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Base branch</span>
              <Input
                type="text"
                value={prForm.base}
                onChange={e => setPrForm(f => ({ ...f, base: e.target.value }))}
                placeholder="main"
                maxLength={255}
              />
            </label>

            {/* Mutation error */}
            {createPrMutation.isError && (
              <p className="flex items-center gap-1.5 text-xs text-red">
                <Icon name="warning" size={14} />
                {createPrMutation.error instanceof Error
                  ? createPrMutation.error.message
                  : 'Failed to create PR'}
              </p>
            )}

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setShowModal(false)} disabled={createPrMutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={createPrMutation.isPending}
                onClick={() => createPrMutation.mutate()}
                disabled={createPrMutation.isPending || !prForm.title.trim() || !prForm.head.trim() || !prForm.base.trim()}
              >
                Create PR
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

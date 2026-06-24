import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GithubStatus, PrInfo, CiRunInfo } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'

interface Props {
  projectId: string
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
  passing: 'bg-[var(--green)]',
  failing:  'bg-[var(--red)]',
  pending:  'bg-[var(--amber)] glow-live',
  none:     'bg-[var(--muted)]',
}

function ciConclusionColor(conclusion: string | null, status: string): string {
  if (status === 'in_progress' || status === 'queued') return 'text-[var(--amber)]'
  if (conclusion === 'success') return 'text-[var(--green)]'
  if (conclusion === 'failure' || conclusion === 'cancelled') return 'text-[var(--red)]'
  return 'text-[var(--muted)]'
}

function ciLabel(run: CiRunInfo): string {
  if (run.status === 'in_progress') return 'in progress'
  if (run.status === 'queued') return 'queued'
  return run.conclusion ?? run.status
}

function PrRow({ pr }: { pr: PrInfo }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors">
      {/* Check dot */}
      <span className={cn('mt-1 w-2 h-2 rounded-full flex-shrink-0', CHECK_DOT[pr.checks] ?? 'bg-[var(--muted)]')} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--muted)]">#{pr.number}</span>
          <p className="text-sm text-[var(--text)] truncate">{pr.title}</p>
        </div>
        <p className="font-mono text-[10px] text-[var(--muted)] mt-0.5">checks: {pr.checks}</p>
      </div>

      {/* External link */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        title="Open on GitHub"
        className="flex-shrink-0 text-[var(--muted)] hover:text-[var(--accent-hover)] transition-colors text-xs mt-0.5"
        aria-label="Open PR on GitHub"
      >
        ↗
      </a>
    </div>
  )
}

function CiRow({ run }: { run: CiRunInfo }) {
  const color = ciConclusionColor(run.conclusion, run.status)
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-[var(--text)] truncate">{run.workflow}</p>
          <span className={cn('font-mono text-xs flex-shrink-0', color)}>{ciLabel(run)}</span>
        </div>
        <p className="font-mono text-[10px] text-[var(--muted)] mt-0.5">
          {run.branch} · {timeAgo(run.createdAt)}
        </p>
      </div>
      <span className="font-mono text-[10px] text-[var(--muted)] flex-shrink-0">
        #{run.id}
      </span>
    </div>
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

  useEffect(() => {
    if (!showModal) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showModal])

  const openPrs = github?.prs.filter(p => p.state === 'OPEN') ?? []
  const ciRuns = github?.ci ?? []

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header bar */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setPrForm(DEFAULT_FORM); createPrMutation.reset(); setShowModal(true) }}
            className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
          >
            + Open PR
          </button>
        </div>
        <span className="font-mono text-[10px] text-[var(--muted)]">
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
        <div className="flex-shrink-0 px-4 py-2 bg-[var(--surface)] border-b border-[var(--border)] text-xs text-[var(--text)] flex items-center gap-2">
          <span className="text-[var(--green)]">PR created:</span>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent-hover)] underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            #{prNumber}
          </a>
          <button
            onClick={() => { setPrUrl(null); setPrNumber(null) }}
            className="ml-auto text-[var(--muted)] hover:text-[var(--text)] transition-colors"
            aria-label="Dismiss"
          >
            x
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--muted)]">
          Loading GitHub status…
        </div>
      )}

      {error && !isLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--red)]">
          Failed to load GitHub status: {String(error)}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* PRs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-[var(--raised)] border-b border-[var(--border)]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Open PRs · {openPrs.length}
              </h3>
            </div>
            {openPrs.length === 0 ? (
              <div className="px-4 py-4 text-xs text-[var(--muted)]">No open PRs.</div>
            ) : (
              openPrs.map(pr => <PrRow key={pr.number} pr={pr} />)
            )}
          </div>

          {/* CI Runs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-[var(--raised)] border-b border-[var(--border)]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                CI Runs · {ciRuns.length}
              </h3>
            </div>
            {ciRuns.length === 0 ? (
              <div className="px-4 py-4 text-xs text-[var(--muted)]">No CI runs.</div>
            ) : (
              ciRuns.map(run => <CiRow key={run.id} run={run} />)
            )}
          </div>
        </>
      )}

      {/* Create PR Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}
        >
          <div
            className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl p-6 flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <h2 id="modal-title" className="text-sm font-semibold text-[var(--text)]">Open Pull Request</h2>

            {/* Title */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Title</span>
              <input
                type="text"
                value={prForm.title}
                onChange={e => setPrForm(f => ({ ...f, title: e.target.value }))}
                placeholder="feat: my change"
                maxLength={255}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
            </label>

            {/* Description */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Description</span>
              <textarea
                value={prForm.body}
                onChange={e => setPrForm(f => ({ ...f, body: e.target.value }))}
                rows={6}
                maxLength={65535}
                placeholder="What does this PR do?"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors resize-y"
              />
            </label>

            {/* Head branch */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Head branch</span>
              <input
                type="text"
                value={prForm.head}
                onChange={e => setPrForm(f => ({ ...f, head: e.target.value }))}
                placeholder="feat/my-branch"
                maxLength={255}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
            </label>

            {/* Base branch */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Base branch</span>
              <input
                type="text"
                value={prForm.base}
                onChange={e => setPrForm(f => ({ ...f, base: e.target.value }))}
                placeholder="main"
                maxLength={255}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
            </label>

            {/* Mutation error */}
            {createPrMutation.isError && (
              <p className="text-xs text-[var(--red)]">
                {createPrMutation.error instanceof Error
                  ? createPrMutation.error.message
                  : 'Failed to create PR'}
              </p>
            )}

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setShowModal(false)}
                disabled={createPrMutation.isPending}
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--text)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={() => createPrMutation.mutate()}
                disabled={createPrMutation.isPending || !prForm.title.trim() || !prForm.head.trim() || !prForm.base.trim()}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--bg)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {createPrMutation.isPending && (
                  <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />
                )}
                Create PR
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

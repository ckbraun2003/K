// FE-5 — full-screen, read-only PR review at #/pr-review/<projectId>/<n>.
// Same ChangesLayout as run review; PR diffs have no expand-context (IN-7)
// and comments stay run-only (readOnly).
import { useQuery } from '@tanstack/react-query'
import type { DiffPayload, GithubStatus } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import ChangesLayout from '../components/ChangesLayout'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'

export default function PrReviewPage({ projectId, prNumber }: { projectId?: string; prNumber?: string }) {
  const n = Number(prNumber)
  const valid = !!projectId && Number.isInteger(n) && n > 0
  const { data: diff, isLoading, error } = useQuery<DiffPayload>({
    queryKey: ['pr-diff', projectId, n],
    queryFn: () => api.projects.prDiff(projectId!, n),
    enabled: valid,
  })
  const { data: github } = useQuery<GithubStatus>({
    queryKey: ['github', projectId],
    queryFn: () => api.projects.github(projectId!),
    enabled: !!projectId,
  })
  const pr = github?.prs.find(p => p.number === n)

  if (!valid) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon="warning" headline="PR not found"
          hint="This review link is malformed or the PR is gone."
          cta={{ label: 'All projects', onClick: () => navigate('projects') }} />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col" data-testid="pr-review-page">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="ghost" size="sm" icon="arrowLeft"
          onClick={() => navigate('project', projectId!, 'prs-ci')}>
          PRs &amp; CI
        </Button>
        <span className="mono text-caption text-muted">#{n}</span>
        <h1 className="min-w-0 flex-1 truncate text-title text-text">{pr?.title ?? 'Pull request review'}</h1>
        {diff && (
          <span className="mono text-label tabular-nums text-muted">
            {diff.files.length} files
            {' '}<span className="text-green">+{diff.files.reduce((s, f) => s + f.additions, 0)}</span>
            {' '}<span className="text-red">−{diff.files.reduce((s, f) => s + f.deletions, 0)}</span>
          </span>
        )}
        {pr && (
          <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label="Open PR on GitHub"
            className="text-muted transition-colors hover:text-accent-hover">
            <Icon name="external" size={14} />
          </a>
        )}
      </header>
      {isLoading && (
        <p className="flex items-center gap-2 p-5 text-caption text-muted"><Spinner size={14} /> Loading diff…</p>
      )}
      {error != null && <p className="p-5 text-caption text-red">{String((error as Error).message)}</p>}
      {diff && (diff.files.length === 0
        ? <EmptyState icon="pr" headline="No file changes in this PR." />
        : <ChangesLayout payload={diff} readOnly />)}
    </div>
  )
}

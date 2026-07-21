import type { Project, GithubStatus, Run } from '@k/shared'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import { formatTimeAgo, relativeTime } from '../lib/verify'
import HealthRubric from './HealthRubric'
import { GlassPanel } from '../ui/GlassPanel'
import { Icon } from '../ui/Icon'
import { Button, IconButton } from '../ui/Button'
import Sparkline from './Sparkline'

// A health score below this flags the card for attention alongside failing CI.
const LOW_HEALTH_THRESHOLD = 50

// Run-status → dot color for the last-run line.
const RUN_DOT: Record<string, string> = {
  queued:      'bg-[var(--amber)]',
  running:     'bg-[var(--accent)]',
  done:        'bg-[var(--green)]',
  error:       'bg-[var(--red)]',
  killed:      'bg-[var(--muted)]',
  interrupted: 'bg-[var(--red)]',
}

function ciState(gh?: GithubStatus): 'passing' | 'failing' | 'unknown' {
  const latest = gh?.ci?.[0]
  if (!latest || !latest.conclusion) return 'unknown'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

// `gh` is supplied by the parent grid via a single fleet-level query
// (lib/useFleetGithub) rather than a per-card fetch — see Wave C6: N cards used
// to fire N parallel /github requests, exhausting the browser socket pool.
export default function ProjectCard({
  project,
  gh,
  lastRun,
  spark,
  onDelete,
}: {
  project: Project
  gh?: GithubStatus
  /** Most recent run for this project (fleet-level batch from the parent grid) —
   *  surfaces last-run status + when on the card (F-065). */
  lastRun?: Run | null
  /** Per-day run counts over the last 14 days (fleet-level batch, no per-card
   *  fetch) — an absent or all-zero series renders no sparkline (no fabricated trend). */
  spark?: number[]
  onDelete?: () => void
}) {
  const ci = ciState(gh)
  const openPrs = gh?.prs.filter(p => p.state === 'OPEN').length ?? 0
  const lowHealth = project.healthScore != null && project.healthScore < LOW_HEALTH_THRESHOLD
  // F-033: localPath vanished on disk (derived server-side). The workspace actions
  // would act against a missing path, so the card badges it and disables them.
  const pathMissing = project.pathMissing === true
  const attention = ci === 'failing' || lowHealth || pathMissing
  const goWorkspace = () => navigate('project', project.id)
  const goVerify = () => navigate('verify', project.id)

  return (
    <GlassPanel
      // glass, not solid (ui-adjustments Round 2, D-133): "panel" is opacity-tint
      // only (no backdrop-filter), so the fleet grid's unbounded card count (2-3
      // cols × N projects) no longer risks the DEV-11 blur budget — that budget
      // only counts real-frost tiers (.glass-overlay/.glass-blur), not this one.
      tier="panel"
      interactive
      data-testid={`project-card-${project.id}`}
      role="button"
      tabIndex={0}
      onClick={goWorkspace}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goWorkspace() } }}
      className={cn('group relative p-4', attention && 'border-amber/40')}
    >
      {onDelete && (
        // variant="ghost" (not the IconButton default "glass") — kept understated
        // so the delete affordance doesn't visually compete with the card's own
        // glass-panel tier; it reveals its own hover:bg-red/15 danger tint anyway.
        <IconButton
          name="trash"
          label={`Delete project ${project.name}`}
          variant="ghost"
          data-testid={`project-delete-btn-${project.id}`}
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="absolute right-2.5 top-2.5 opacity-0 hover:bg-red/15 hover:text-red focus:opacity-100 group-hover:opacity-100"
        />
      )}
      <div className="flex items-center gap-2 pr-7">
        <span
          className={cn('h-2 w-2 rounded-full', {
            'bg-green': ci === 'passing',
            'bg-amber glow-live': ci === 'failing',
            'bg-muted': ci === 'unknown',
          })}
        />
        <span className="truncate text-title text-text">{project.name}</span>
        {project.healthScore != null && (
          <span className="ml-auto">
            <HealthRubric score={project.healthScore} showScore />
          </span>
        )}
      </div>
      <p className="mt-1.5 text-caption text-muted">
        {project.githubRemote ? (
          <>
            <span className={cn('inline-flex items-center gap-1', ci === 'failing' && 'text-amber')}>
              <span>CI</span>
              {ci === 'passing' && (
                <span className="inline-flex items-center gap-1">
                  <Icon name="check" size={14} className="text-green" />
                  passing
                </span>
              )}
              {ci === 'failing' && (
                <span className="inline-flex items-center gap-1">
                  <Icon name="close" size={14} className="text-amber" />
                  failing
                </span>
              )}
              {ci === 'unknown' && <span>—</span>}
            </span>
            {' · '}
            <span className="inline-flex items-center gap-1">
              <Icon name="pr" size={14} />
              <span><span className="mono">{openPrs}</span> open PR{openPrs === 1 ? '' : 's'}</span>
            </span>
          </>
        ) : (
          'no GitHub remote — registry invariant unmet'
        )}
      </p>
      <p className="mono mt-2 truncate text-caption text-muted">{project.localPath}</p>
      {pathMissing && (
        <p
          data-testid={`project-card-pathmissing-${project.id}`}
          className="mt-2 flex items-center gap-1.5 rounded-control border border-red/40 bg-red/10 px-2 py-1 text-micro font-medium text-red"
        >
          <Icon name="warning" size={14} className="text-red" />
          path missing — the repo folder is gone; workspace actions are disabled
        </p>
      )}
      {lastRun && (
        <p
          data-testid={`project-card-lastrun-${project.id}`}
          className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--muted)]"
        >
          <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', RUN_DOT[lastRun.status] ?? 'bg-[var(--muted)]')} />
          <span className="truncate">last run {lastRun.status} · {relativeTime(lastRun.createdAt)}</span>
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('flex-shrink-0 text-[10px]', lowHealth ? 'text-[var(--amber)]' : 'text-[var(--muted)]')}>
            {formatTimeAgo(project.lastVerifiedAt)}
          </span>
          {spark && spark.some(v => v > 0) && (
            <span title="runs/day · 14d" className="flex-shrink-0">
              <Sparkline values={spark} width={72} height={18} stroke="var(--accent-hover)" />
            </span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`project-verify-btn-${project.id}`}
          onClick={e => { e.stopPropagation(); if (!pathMissing) goVerify() }}
          disabled={pathMissing}
          title={pathMissing ? 'Path missing — restore the repo folder to verify' : undefined}
          className="text-accent-hover hover:text-accent-hover"
        >
          Run verification
        </Button>
      </div>
    </GlassPanel>
  )
}

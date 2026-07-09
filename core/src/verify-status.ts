/**
 * E-06 — verify result → GitHub commit status (context k/verify), published onto
 * the run's FINAL CHECKPOINT sha (the exact sha approve pushes as the PR branch,
 * review.ts:214-215). Linked = the cached PR list has an OPEN PR whose
 * headRefName is k-review/<runId8> — so a re-verify AFTER the PR exists flips
 * the status (the live blocked-then-green leg). skipped is NOT published: an
 * absent context is the honest "unverified" (D-083).
 */
import type { Project, VerifyResult, PrInfo } from '@k/shared'
import { runsDb } from './db.js'
import { getGithubStatus, publishCommitStatus, fetchPrMergeReadiness, mergePr, type CommitStatusState } from './github.js'
import { listRunCheckpoints } from './checkpoints.js'

export function reviewBranchFor(runId: string): string {
  return `k-review/${runId.slice(0, 8)}`
}

export function verifyStatusFor(result: VerifyResult): { state: CommitStatusState; description: string } | null {
  const ok = result.commands.filter(c => c.ok).length
  const total = result.commands.length
  const secs = result.completedAt != null ? Math.round((result.completedAt - result.startedAt) / 1000) : null
  const measured = `${ok}/${total} verify commands passed${secs != null ? ` in ${secs}s` : ''}`
  switch (result.status) {
    case 'running': return { state: 'pending', description: 'verification running' }
    case 'pass':    return { state: 'success', description: measured }
    case 'fail':    return { state: 'failure', description: measured }
    case 'error':   return { state: 'error', description: (result.reason ?? 'verify error').slice(0, 140) }
    case 'skipped': return null
  }
}

/** Publish if (and only if) the run is PR-linked. Returns whether a publish happened. */
export async function publishVerifyStatusIfLinked(
  result: VerifyResult,
  resolveProject: (id: string) => Project | null,
): Promise<boolean> {
  const mapped = verifyStatusFor(result)
  if (!mapped) return false
  const row = runsDb.getRun.get(result.runId) as Record<string, unknown> | undefined
  if (!row || row.project_id == null) return false
  const project = resolveProject(String(row.project_id))
  if (!project?.githubRemote) return false
  const branch = reviewBranchFor(result.runId)
  const prs = getGithubStatus(project.id).prs as PrInfo[]
  if (!prs.some(pr => pr.headRefName === branch && String(pr.state).toUpperCase() === 'OPEN')) return false
  const ckpts = listRunCheckpoints(result.runId)
  if (ckpts.length === 0) return false
  await publishCommitStatus(project.githubRemote, ckpts[ckpts.length - 1].sha, mapped)
  // E-06 auto-merge (default OFF): after a green verify, opt-in projects merge
  // automatically — fire-and-forget so the publish path never blocks on gh, and
  // the guarded readback inside means it NEVER merges around a red/pending check.
  if (mapped.state === 'success' && project.autoMerge === true) {
    void attemptAutoMerge(project, result.runId).catch(err => console.warn('[auto-merge] failed:', (err as Error).message))
  }
  return true
}

/** E-06 auto-merge (default OFF): same green-readback guard as the route — the
 *  flag never bypasses the check, it only removes the click. */
async function attemptAutoMerge(project: Project, runId: string): Promise<void> {
  const branch = reviewBranchFor(runId)
  const pr = (getGithubStatus(project.id).prs as PrInfo[])
    .find(p => p.headRefName === branch && String(p.state).toUpperCase() === 'OPEN')
  if (!pr || !project.githubRemote) return
  const ready = await fetchPrMergeReadiness(project.githubRemote, pr.number, project.localPath)
  if (String(ready.state).toUpperCase() !== 'OPEN' || ready.checks !== 'passing') {
    console.log(`[auto-merge] PR #${pr.number} not green yet (${ready.checks}) — skipped`)
    return
  }
  await mergePr(project.githubRemote, pr.number)
  console.log(`[auto-merge] merged PR #${pr.number} (${project.name})`)
}

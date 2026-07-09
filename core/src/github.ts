/**
 * GitHubProvider — bible §4. First implementation: authenticated `gh` CLI.
 * Polls registered projects, caches results in SQLite, broadcasts deltas
 * as github_update WS messages via the EventBus.
 */

import { execa } from 'execa'
import { randomUUID } from 'crypto'
import type { GithubStatus, PrInfo, CiRunInfo, IssueInfo, Project } from '@k/shared'
import { parsePrList, parseCiRuns, parseIssueList, rollupChecks } from './github-parse.js'
import { githubDb, projectWorkItemsDb } from './db.js'
import { eventBus } from './events.js'
import { listProjects } from './projects.js'

const rawPollMs = Number(process.env.GITHUB_POLL_MS)
const POLL_MS = Number.isFinite(rawPollMs) && rawPollMs > 0 ? rawPollMs : 60_000

async function ghJson(args: string[], cwd: string): Promise<unknown> {
  const { stdout } = await execa('gh', [...args], { cwd, timeout: 30_000 })
  return JSON.parse(stdout)
}

export async function fetchGithubStatus(remote: string, cwd: string): Promise<{ prs: PrInfo[]; ci: CiRunInfo[] }> {
  const [prsRaw, ciRaw] = await Promise.all([
    ghJson(['pr', 'list', '--repo', remote, '--json', 'number,title,state,url,statusCheckRollup,headRefName'], cwd),
    ghJson(['run', 'list', '--repo', remote, '--limit', '10', '--json', 'databaseId,workflowName,headBranch,status,conclusion,createdAt'], cwd),
  ])
  return { prs: parsePrList(prsRaw), ci: parseCiRuns(ciRaw) }
}

// ─── Issues sync ───────────────────────────────────────────────────────────────

export async function fetchIssues(remote: string, cwd: string): Promise<IssueInfo[]> {
  const raw = await ghJson(
    ['issue', 'list', '--repo', remote, '--json', 'number,title,state,url', '--state', 'all', '--limit', '50'],
    cwd,
  )
  return parseIssueList(raw)
}

/**
 * Sync a project's GitHub issues into its project tasks (work_items
 * scope='project'). Mirrors the poller's
 * degradation contract: gh absent / unauth / offline never throws — it returns
 * { synced: 0, degraded: true } and keeps existing tasks intact.
 *
 * Status mapping (issue → task):
 *   - new + issue open    → insert task 'open'
 *   - new + issue closed  → insert task 'done' (completed_at = now)
 *   - existing + closed   → 'done' (set completed_at if not already done)
 *   - existing + open & task 'done' → reopen to 'open' (clear completed_at)
 *   - existing otherwise  → leave status (don't clobber a user's 'in_progress')
 * Title + issue_url + issue_state always refresh on update.
 */
export async function syncIssues(
  project: Project,
  fetch: typeof fetchIssues = fetchIssues,
): Promise<{ synced: number; degraded: boolean }> {
  if (!project.githubRemote) return { synced: 0, degraded: true }
  try {
    const issues = await fetch(project.githubRemote, project.localPath)
    let synced = 0
    for (const issue of issues) {
      const closed = issue.state.toUpperCase() === 'CLOSED'
      const existing = projectWorkItemsDb.getProjectTaskByIssue.get(project.id, issue.number) as
        | Record<string, unknown>
        | undefined
      if (existing) {
        const currentStatus = String(existing.status)
        let status = currentStatus
        let completedAt = existing.completed_at == null ? null : Number(existing.completed_at)
        if (closed) {
          status = 'done'
          if (currentStatus !== 'done') completedAt = Date.now()
        } else if (currentStatus === 'done') {
          // issue reopened upstream → reopen the task
          status = 'open'
          completedAt = null
        }
        // else: open issue, task open/in_progress → leave status untouched
        projectWorkItemsDb.updateProjectTaskFromIssue.run({
          id: String(existing.id),
          projectId: project.id,
          title: issue.title,
          issueUrl: issue.url,
          issueState: issue.state,
          status,
          completedAt,
        })
      } else {
        const now = Date.now()
        projectWorkItemsDb.insertProjectTask.run({
          id: randomUUID(),
          projectId: project.id,
          title: issue.title,
          status: closed ? 'done' : 'open',
          createdAt: now,
          completedAt: closed ? now : null,
          issueNumber: issue.number,
          issueUrl: issue.url,
          issueState: issue.state,
        })
      }
      synced++
    }
    eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'issue', payload: issues })
    return { synced, degraded: false }
  } catch (e) {
    // Offline / rate-limited / gh unauthenticated → nothing synced, not an error
    console.warn(`[github] issue sync failed for ${project.name}: ${e instanceof Error ? e.message : e}`)
    return { synced: 0, degraded: true }
  }
}

function parsePayload<T>(row: Record<string, unknown> | undefined): T[] {
  if (!row) return []
  try {
    const v = JSON.parse(String(row.payload))
    return Array.isArray(v) ? v : []
  } catch {
    return [] // corrupted cache row — treat as never fetched rather than 500
  }
}

export function getGithubStatus(projectId: string): GithubStatus {
  const pr = githubDb.getGithubCache.get(projectId, 'pr') as Record<string, unknown> | undefined
  const ci = githubDb.getGithubCache.get(projectId, 'ci') as Record<string, unknown> | undefined
  const stamps = [pr, ci].filter((r): r is Record<string, unknown> => !!r).map((r) => Number(r.fetched_at))
  return {
    prs: parsePayload<PrInfo>(pr),
    ci: parsePayload<CiRunInfo>(ci),
    fetchedAt: stamps.length ? Math.max(...stamps) : null,
  }
}

/**
 * Delta predicate — true when the freshly-fetched payload differs from the
 * previously-cached one, so a github_update broadcast is warranted. Pure: a
 * structural JSON compare, order-sensitive (the gh CLI yields a stable order).
 */
export function hasChanged(prev: unknown, next: unknown): boolean {
  return JSON.stringify(prev) !== JSON.stringify(next)
}

let polling = false

// Projects already warned about a missing localPath — warn ONCE per boot per
// project instead of spamming the log every poll cycle.
const warnedMissingPath = new Set<string>()

/**
 * One poll cycle over every registered project with a remote. The gh-invoking
 * fetch is injectable (defaults to the real `fetchGithubStatus`) so the
 * reentrancy guard and delta/broadcast logic are unit-testable without `gh`.
 */
async function pollOnce(fetch: typeof fetchGithubStatus = fetchGithubStatus): Promise<void> {
  if (polling) return
  polling = true
  try {
  for (const project of listProjects()) {
    if (!project.githubRemote) continue
    // Degrade on a vanished localPath (pathMissing is computed by rowToProject —
    // single source of truth): previously a stale project row spammed
    // `poll failed ... ENOENT` every 60s forever. Warn once per boot, skip the
    // fetch, and NEVER delete or mutate the project row.
    if (project.pathMissing) {
      if (!warnedMissingPath.has(project.id)) {
        warnedMissingPath.add(project.id)
        console.warn(`[github] skipping poll for ${project.name}: localPath ${project.localPath} no longer exists`)
      }
      continue
    }
    try {
      const before = getGithubStatus(project.id)
      const { prs, ci } = await fetch(project.githubRemote, project.localPath)
      const now = Date.now()
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'pr', payload: JSON.stringify(prs), fetchedAt: now })
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'ci', payload: JSON.stringify(ci), fetchedAt: now })
      if (hasChanged(before.prs, prs)) {
        eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'pr', payload: prs })
      }
      if (hasChanged(before.ci, ci)) {
        eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'ci', payload: ci })
      }
    } catch (e) {
      // Offline / rate-limited / gh unauthenticated → keep serving cache (bible §4 failure modes)
      console.warn(`[github] poll failed for ${project.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
  } finally {
    polling = false
  }
}

// Exported under a test-only alias so the suite can drive pollOnce with an
// injected fetcher and exercise the reentrancy guard. Production callers
// (startGithubPoller) keep using the zero-arg form. Non-behavioral.
export const __pollOnce = pollOnce

// ─── createPR ────────────────────────────────────────────────────────────────

export interface CreatePrOpts {
  title: string
  body: string
  head: string
  base: string
}

export async function createPR(
  remote: string,
  opts: CreatePrOpts,
): Promise<{ number: number; url: string; title: string; state: string }> {
  let stdout: string
  try {
    // `gh pr create` does NOT support --json; on success it prints the new PR's
    // URL to stdout (possibly alongside other informational lines).
    const result = await execa(
      'gh',
      [
        'pr', 'create',
        '--repo', remote,
        '--title', opts.title,
        '--body', opts.body,
        '--head', opts.head,
        '--base', opts.base,
      ],
      { timeout: 60_000 },
    )
    stdout = result.stdout
  } catch (e) {
    const err = e as { stderr?: string; exitCode?: number }
    // Sanitize gh stderr — it may contain repo URLs or auth hints. Strip URLs in
    // place (do NOT drop whole lines, or real error text would be discarded).
    const sanitized = (err.stderr ?? '').replace(/https?:\/\/\S+/g, '[url]').trim()
    throw new Error(sanitized || 'gh pr create failed')
  }
  const match = stdout.match(/https?:\/\/\S*\/pull\/(\d+)/)
  if (!match) throw new Error('gh pr create succeeded but no PR URL was returned')
  return {
    number: parseInt(match[1], 10),
    url: match[0],
    title: opts.title,
    state: 'open',
  }
}

// ─── P2 E-06: verification as a GitHub-native commit status ─────────────────

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error'

/**
 * POST a commit status onto `sha` (context defaults to k/verify — the ONE
 * context K owns; branch protection can require it, bible §06). Errors are
 * URL-sanitized exactly like createPR: gh stderr may echo remote URLs.
 */
export async function publishCommitStatus(
  remote: string,
  sha: string,
  opts: { state: CommitStatusState; description: string; context?: string },
): Promise<void> {
  try {
    await execa('gh', [
      'api', `repos/${remote}/statuses/${sha}`,
      '-f', `state=${opts.state}`,
      '-f', `context=${opts.context ?? 'k/verify'}`,
      '-f', `description=${opts.description.slice(0, 140)}`,
    ], { timeout: 30_000 })
  } catch (e) {
    const err = e as { stderr?: string }
    const sanitized = (err.stderr ?? '').replace(/https?:\/\/\S+/g, '[url]').trim()
    throw new Error(sanitized || 'gh api commit-status failed')
  }
}

// ─── P2 E-06: one-click merge readback + merge ──────────────────────────────

/** Merge readiness readback — state + the SAME checks projection the poller uses. */
export async function fetchPrMergeReadiness(
  remote: string, number: number, cwd: string,
): Promise<{ state: string; checks: PrInfo['checks'] }> {
  try {
    const raw = await ghJson(['pr', 'view', String(number), '--repo', remote, '--json', 'state,statusCheckRollup'], cwd) as Record<string, unknown>
    return { state: String(raw.state ?? ''), checks: rollupChecks(raw.statusCheckRollup) }
  } catch (e) {
    // Same URL-sanitize idiom as createPR/mergePr/publishCommitStatus: gh stderr may
    // echo remote URLs or auth-hint links, and this helper's error surfaces to the
    // client as a 502 (routes/merge.ts) — the other ghJson callers only log + degrade.
    const err = e as { stderr?: string }
    const sanitized = (err.stderr ?? '').replace(/https?:\/\/\S+/g, '[url]').trim()
    throw new Error(sanitized || 'gh pr view failed')
  }
}

/** Merge-commit merge (matches the repo's own --no-ff history). */
export async function mergePr(remote: string, number: number): Promise<void> {
  try {
    await execa('gh', ['pr', 'merge', String(number), '--repo', remote, '--merge'], { timeout: 60_000 })
  } catch (e) {
    const err = e as { stderr?: string }
    const sanitized = (err.stderr ?? '').replace(/https?:\/\/\S+/g, '[url]').trim()
    throw new Error(sanitized || 'gh pr merge failed')
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export function startGithubPoller(): void {
  if (pollTimer || process.env.ENABLE_GITHUB_POLL === 'false') return
  void pollOnce()
  pollTimer = setInterval(() => void pollOnce(), POLL_MS)
  console.log(`[github] poller started (every ${POLL_MS / 1000}s)`)
}

export function stopGithubPoller(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

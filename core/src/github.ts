/**
 * GitHubProvider — bible §4. First implementation: authenticated `gh` CLI.
 * Polls registered projects, caches results in SQLite, broadcasts deltas
 * as github_update WS messages via the EventBus.
 */

import { execa } from 'execa'
import type { GithubStatus, PrInfo, CiRunInfo } from '@k/shared'
import { parsePrList, parseCiRuns } from './github-parse.js'
import { githubDb } from './db.js'
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
    ghJson(['pr', 'list', '--repo', remote, '--json', 'number,title,state,url,statusCheckRollup'], cwd),
    ghJson(['run', 'list', '--repo', remote, '--limit', '10', '--json', 'databaseId,workflowName,headBranch,status,conclusion,createdAt'], cwd),
  ])
  return { prs: parsePrList(prsRaw), ci: parseCiRuns(ciRaw) }
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
  let stderr: string
  try {
    const result = await execa(
      'gh',
      [
        'pr', 'create',
        '--repo', remote,
        '--title', opts.title,
        '--body', opts.body,
        '--head', opts.head,
        '--base', opts.base,
        '--json', 'number,url,title,state',
      ],
      { timeout: 60_000 },
    )
    stdout = result.stdout
    stderr = result.stderr
  } catch (e) {
    const err = e as { stderr?: string; exitCode?: number }
    // Sanitize gh stderr — it may contain repo URLs, branch names, or auth hints
    const ghMsg = err.stderr?.split('\n').find(l => l.trim() && !l.includes('http'))?.trim()
    throw new Error(ghMsg || 'gh pr create failed')
  }
  if (!stdout) throw new Error('gh pr create produced no output')
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`gh pr create returned unexpected output: ${stdout.slice(0, 120)}`)
  }
  return parsed as { number: number; url: string; title: string; state: string }
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

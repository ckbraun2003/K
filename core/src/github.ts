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

let polling = false

async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  try {
  for (const project of listProjects()) {
    if (!project.githubRemote) continue
    try {
      const before = getGithubStatus(project.id)
      const { prs, ci } = await fetchGithubStatus(project.githubRemote, project.localPath)
      const now = Date.now()
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'pr', payload: JSON.stringify(prs), fetchedAt: now })
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'ci', payload: JSON.stringify(ci), fetchedAt: now })
      if (JSON.stringify(prs) !== JSON.stringify(before.prs)) {
        eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'pr', payload: prs })
      }
      if (JSON.stringify(ci) !== JSON.stringify(before.ci)) {
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

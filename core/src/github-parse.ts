/** Pure projections from `gh … --json` payloads — no subprocess, no DB. */

import type { PrInfo, CiRunInfo, IssueInfo } from '@k/shared'

function rollupChecks(rollup: unknown): PrInfo['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const conclusion = (c as Record<string, unknown>)?.conclusion
    if (conclusion == null || conclusion === '') pending = true
    else if (
      String(conclusion).toUpperCase() !== 'SUCCESS' &&
      String(conclusion).toUpperCase() !== 'SKIPPED' &&
      String(conclusion).toUpperCase() !== 'NEUTRAL'
    ) return 'failing'
  }
  return pending ? 'pending' : 'passing'
}

export function parsePrList(json: unknown): PrInfo[] {
  if (!Array.isArray(json)) return []
  const out: PrInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.number !== 'number' || typeof r?.title !== 'string') continue
    out.push({
      number: r.number,
      title: r.title,
      state: String(r.state ?? 'OPEN'),
      url: String(r.url ?? ''),
      checks: rollupChecks(r.statusCheckRollup),
    })
  }
  return out
}

export function parseIssueList(json: unknown): IssueInfo[] {
  if (!Array.isArray(json)) return []
  const out: IssueInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.number !== 'number' || typeof r?.title !== 'string') continue
    out.push({
      number: r.number,
      title: r.title,
      state: String(r.state ?? 'OPEN'),
      url: String(r.url ?? ''),
    })
  }
  return out
}

export function parseCiRuns(json: unknown): CiRunInfo[] {
  if (!Array.isArray(json)) return []
  const out: CiRunInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.databaseId !== 'number') continue
    out.push({
      id: r.databaseId,
      workflow: String(r.workflowName ?? ''),
      branch: String(r.headBranch ?? ''),
      status: String(r.status ?? ''),
      conclusion: r.conclusion == null || r.conclusion === '' ? null : String(r.conclusion),
      createdAt: String(r.createdAt ?? ''),
    })
  }
  return out
}

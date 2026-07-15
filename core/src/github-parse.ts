/** Pure projections from `gh … --json` payloads — no subprocess, no DB. */

import type { PrInfo, CiRunInfo, IssueInfo } from '@k/shared'

/**
 * Only http(s) URLs survive ingest. `gh … --json url` is normally a github.com
 * link, but the value is rendered as an `<a href>` in the web UI; gating the
 * scheme here (the boundary) blocks a `javascript:`/`data:` href from ever being
 * stored, rather than relying on the React renderer to neutralise it at paint.
 */
function safeHttpUrl(raw: unknown): string {
  const s = String(raw ?? '')
  return /^https?:\/\//i.test(s) ? s : ''
}

export function rollupChecks(rollup: unknown): PrInfo['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const rec = c as Record<string, unknown>
    // CheckRun rows carry `conclusion`; StatusContext rows (commit statuses —
    // e.g. K's k/verify) carry `state`. Read whichever is present (P2 E-06).
    const verdict = rec?.conclusion ?? rec?.state
    const v = verdict == null ? '' : String(verdict).toUpperCase()
    if (v === '' || v === 'PENDING' || v === 'EXPECTED') pending = true
    else if (v !== 'SUCCESS' && v !== 'SKIPPED' && v !== 'NEUTRAL') return 'failing'
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
      url: safeHttpUrl(r.url),
      checks: rollupChecks(r.statusCheckRollup),
      headRefName: typeof r.headRefName === 'string' ? r.headRefName : undefined,
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
      url: safeHttpUrl(r.url),
    })
  }
  return out
}

/** IN-2: wall-clock duration for a COMPLETED run only (updatedAt - createdAt), when
 *  both timestamps parse. A still-running/queued run has no end timestamp yet — never
 *  fabricate a duration from a partial pair. */
function ciDurationMs(status: string, createdAt: unknown, updatedAt: unknown): number | undefined {
  if (status !== 'completed') return undefined
  const start = Date.parse(String(createdAt ?? ''))
  const end = Date.parse(String(updatedAt ?? ''))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

export function parseCiRuns(json: unknown): CiRunInfo[] {
  if (!Array.isArray(json)) return []
  const out: CiRunInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.databaseId !== 'number') continue
    const status = String(r.status ?? '')
    const durationMs = ciDurationMs(status, r.createdAt, r.updatedAt)
    out.push({
      id: r.databaseId,
      workflow: String(r.workflowName ?? ''),
      branch: String(r.headBranch ?? ''),
      status,
      conclusion: r.conclusion == null || r.conclusion === '' ? null : String(r.conclusion),
      createdAt: String(r.createdAt ?? ''),
      ...(durationMs != null ? { durationMs } : {}),
    })
  }
  return out
}

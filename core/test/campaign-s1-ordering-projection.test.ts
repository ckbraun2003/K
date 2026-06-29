/**
 * Campaign S1 — list ordering, LIMIT edge, and defensive JSON projection
 * (LOCK / characterization).
 *
 *  - createdAt ties: the run-list ORDER BY created_at DESC has NO secondary
 *    tiebreaker, so the order AMONG rows with an identical created_at is NOT
 *    stable — it depends on the query plan (index scan vs sort) and was observed
 *    to differ between an isolated run and a populated DB. The list still returns
 *    every matching row and still orders DISTINCT timestamps correctly; only the
 *    intra-tie order is unspecified (S1-011, Robustness).
 *  - LIMIT edge: SQLite treats a negative LIMIT as "unbounded", so passing a
 *    negative limit returns ALL matching rows — a footgun for any caller that
 *    computes the limit (S1-012).
 *  - rowToReport defensively parses JSON columns: garbage / non-array / null
 *    degrade to [] (findings, fixes_applied) or an omitted breakdown — one bad
 *    row can never throw out of the projector (S1-013).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb, rowToReport } from '../src/db.js'

const projectIds: string[] = []
const runIds: string[] = []

function mkProject(): string {
  const id = uuid()
  projectsDb.insertProject.run({
    id, name: 'ord-' + id, localPath: '/tmp/' + id, githubRemote: null,
    workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  projectIds.push(id)
  return id
}

function mkRun(projectId: string, prompt: string, createdAt: number): string {
  const id = uuid()
  runsDb.insertRun.run({
    id, prompt, cwd: '/tmp', worktree: null, status: 'queued', provider: 'claude',
    model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId, createdAt,
  })
  runIds.push(id)
  return id
}

afterAll(() => {
  for (const id of runIds) db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id)
})

describe('S1 — createdAt ordering ties', () => {
  it('returns every tied row but does NOT guarantee a stable order among them', () => {
    const projectId = mkProject()
    const t = Date.now()
    mkRun(projectId, 'A', t)
    mkRun(projectId, 'B', t)
    mkRun(projectId, 'C', t)
    const rows = runsDb.listRunsFiltered({ projectId, limit: 100 }) as Array<{ prompt: string }>
    // All three are present; the intra-tie order is unspecified (plan-dependent),
    // so we only assert the set, not the sequence.
    expect([...rows.map(r => r.prompt)].sort()).toEqual(['A', 'B', 'C'])
  })

  it('orders DISTINCT created_at values correctly (newest first)', () => {
    const projectId = mkProject()
    const t = Date.now()
    mkRun(projectId, 'old', t)
    mkRun(projectId, 'mid', t + 1000)
    mkRun(projectId, 'new', t + 2000)
    const rows = runsDb.listRunsFiltered({ projectId, limit: 100 }) as Array<{ prompt: string }>
    expect(rows.map(r => r.prompt)).toEqual(['new', 'mid', 'old'])
  })
})

describe('S1 — negative LIMIT is treated as unbounded', () => {
  it('listRunsFiltered with limit -1 returns ALL rows for the scope', () => {
    const projectId = mkProject()
    const t = Date.now()
    mkRun(projectId, 'r1', t)
    mkRun(projectId, 'r2', t + 1)
    mkRun(projectId, 'r3', t + 2)
    expect(runsDb.listRunsFiltered({ projectId, limit: 1 })).toHaveLength(1)
    expect(runsDb.listRunsFiltered({ projectId, limit: -1 })).toHaveLength(3) // unbounded
  })
})

describe('S1 — rowToReport defensive JSON projection', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'r', project_id: 'p', score: 50, findings: '[]', fixes_applied: '[]',
    started_at: 1, completed_at: null, score_breakdown: null, ...over,
  })

  it('malformed findings/fixes JSON degrades to empty arrays without throwing', () => {
    const rep = rowToReport(row({ findings: '{not json', fixes_applied: 'also-bad' }))
    expect(rep.findings).toEqual([])
    expect(rep.fixesApplied).toEqual([])
  })

  it('valid-but-non-array JSON also degrades to empty arrays', () => {
    const rep = rowToReport(row({ findings: '{"a":1}', fixes_applied: '42' }))
    expect(rep.findings).toEqual([])
    expect(rep.fixesApplied).toEqual([])
  })

  it('null JSON columns degrade to empty arrays', () => {
    const rep = rowToReport(row({ findings: null, fixes_applied: null }))
    expect(rep.findings).toEqual([])
    expect(rep.fixesApplied).toEqual([])
  })

  it('garbled score_breakdown leaves breakdown undefined; null omits it', () => {
    expect(rowToReport(row({ score_breakdown: '{bad' })).breakdown).toBeUndefined()
    expect(rowToReport(row({ score_breakdown: null })).breakdown).toBeUndefined()
  })

  it('well-formed JSON parses through', () => {
    const rep = rowToReport(row({
      findings: JSON.stringify([{ severity: 'low', message: 'm' }]),
      fixes_applied: JSON.stringify(['fix-1']),
      score_breakdown: JSON.stringify({ ci: 10 }),
      completed_at: 999,
    }))
    expect(rep.findings).toHaveLength(1)
    expect(rep.fixesApplied).toEqual(['fix-1'])
    expect(rep.breakdown).toEqual({ ci: 10 })
    expect(rep.completedAt).toBe(999)
  })
})

/**
 * Tests for server-side run filters: listRunsFiltered + RunsQuerySchema validation.
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { runsDb, db } from '../src/db.js'
import { RunsQuerySchema } from '@k/shared'

// Unique prefix so parallel test runs don't collide
const PREFIX = `rqtest-${Date.now()}`

function makeRun(status: string, offset = 0) {
  return {
    id: uuid(),
    prompt: `${PREFIX} prompt`,
    cwd: '/tmp/test',
    worktree: null,
    status,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    projectId: null,
    createdAt: Date.now() + offset,
  }
}

const runs = [
  makeRun('done',    0),
  makeRun('done',    1),
  makeRun('error',   2),
  makeRun('killed',  3),
  makeRun('running', 4),
  makeRun('queued',  5),
]

// Insert all test runs up front
for (const r of runs) runsDb.insertRun.run(r)

afterAll(() => {
  const ids = runs.map(r => r.id)
  db.prepare(`DELETE FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(...ids)
})

describe('listRunsFiltered', () => {
  it('(a) default (no status) returns all inserted rows, ordered desc, capped at limit', () => {
    const rows = runsDb.listRunsFiltered({ limit: 100 }) as Array<{ id: string; created_at: number }>
    // At least our 6 inserted rows are present
    const ours = rows.filter(r => runs.some(x => x.id === r.id))
    expect(ours).toHaveLength(6)
    // Verify descending order over our rows
    const times = ours.map(r => r.created_at)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('(b) status filter returns only matching rows', () => {
    const rows = runsDb.listRunsFiltered({ status: 'done', limit: 100 }) as Array<{ id: string; status: string }>
    const ours = rows.filter(r => runs.some(x => x.id === r.id))
    expect(ours).toHaveLength(2)
    expect(ours.every(r => r.status === 'done')).toBe(true)
  })

  it('(c) limit caps the count', () => {
    const rows = runsDb.listRunsFiltered({ limit: 3 }) as Array<{ id: string }>
    // ≥6 rows present → LIMIT 3 returns exactly 3 (proves the bound applies, not just an upper cap)
    expect(rows.length).toBe(3)
  })

  it('(c) status + limit together', () => {
    // 2 done runs inserted; limit=1 should return exactly 1
    const rows = runsDb.listRunsFiltered({ status: 'done', limit: 1 }) as Array<{ status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('done')
  })
})

describe('RunsQuerySchema validation', () => {
  it('(d) valid — no params — defaults to limit 100', () => {
    const r = RunsQuerySchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ limit: 100 })
  })

  it('(d) valid status + limit', () => {
    const r = RunsQuerySchema.safeParse({ status: 'done', limit: '50' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ status: 'done', limit: 50 })
  })

  it('(d) rejects bogus status', () => {
    const r = RunsQuerySchema.safeParse({ status: 'bogus' })
    expect(r.success).toBe(false)
  })

  it('(d) rejects limit=0', () => {
    const r = RunsQuerySchema.safeParse({ limit: '0' })
    expect(r.success).toBe(false)
  })

  it('(d) rejects limit=501', () => {
    const r = RunsQuerySchema.safeParse({ limit: '501' })
    expect(r.success).toBe(false)
  })

  it('(d) accepts limit=500 (boundary)', () => {
    const r = RunsQuerySchema.safeParse({ limit: '500' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(500)
  })

  it('(d) accepts limit=1 (boundary)', () => {
    const r = RunsQuerySchema.safeParse({ limit: '1' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(1)
  })
})

// ─── A.3 (D-127): the runs.kind filter ───────────────────────────────────────

describe('listRunsFiltered — kinds filter (A.3, D-127)', () => {
  const KP = `rqkind-${Date.now()}`
  const kindRuns = [
    { ...makeRun('done', 10), prompt: `${KP} job`, kind: 'job' },
    { ...makeRun('done', 11), prompt: `${KP} chat`, kind: 'chat-turn' },
    { ...makeRun('running', 12), prompt: `${KP} stage`, kind: 'pipeline-stage' },
  ]
  const mine = (rows: Array<Record<string, unknown>>) =>
    rows.filter(r => String(r.prompt).startsWith(KP))

  beforeAll(() => { for (const r of kindRuns) runsDb.insertRun.run(r) })
  afterAll(() => {
    for (const r of kindRuns) db.prepare('DELETE FROM runs WHERE id = ?').run(r.id)
  })

  it('(e) a single kind returns only matching rows', () => {
    const ours = mine(runsDb.listRunsFiltered({ kinds: ['job'], limit: 100 }))
    expect(ours).toHaveLength(1)
    expect(ours[0].kind).toBe('job')
  })

  it('(e) multiple kinds compose as an IN list', () => {
    const ours = mine(runsDb.listRunsFiltered({ kinds: ['job', 'pipeline-stage'], limit: 100 }))
    expect(ours).toHaveLength(2)
    expect(ours.map(r => r.kind).sort()).toEqual(['job', 'pipeline-stage'])
  })

  it('(e) kinds + status compose', () => {
    const ours = mine(runsDb.listRunsFiltered({ kinds: ['chat-turn'], status: 'done', limit: 100 }))
    expect(ours).toHaveLength(1)
    expect(ours[0].kind).toBe('chat-turn')
    expect(ours[0].status).toBe('done')
  })

  it('(e) no kinds → every kind (byte-compatible with the pre-A.3 list)', () => {
    const ours = mine(runsDb.listRunsFiltered({ limit: 100 }))
    expect(ours).toHaveLength(3)
  })

  it('(e) duplicate kinds are deduped — bounded statement shapes, identical results (review MAJOR-1)', () => {
    // The wire schema validates VALUES, not multiplicity — the dedupe in
    // listRunsFiltered is what bounds the per-shape statement cache (IN sizes
    // 1..3). Behavioral lock: duplicates return exactly the single-kind result.
    const ours = mine(runsDb.listRunsFiltered({ kinds: ['job', 'job', 'job'], limit: 100 }))
    expect(ours).toHaveLength(1)
    expect(ours[0].kind).toBe('job')
  })
})

describe('RunsQuerySchema — kind param (A.3, D-127)', () => {
  it("(f) kind=job parses to ['job']", () => {
    const r = RunsQuerySchema.safeParse({ kind: 'job' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.kind).toEqual(['job'])
  })

  it('(f) kind=job,pipeline-stage splits on the comma', () => {
    const r = RunsQuerySchema.safeParse({ kind: 'job,pipeline-stage' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.kind).toEqual(['job', 'pipeline-stage'])
  })

  it('(f) rejects an unknown kind', () => {
    expect(RunsQuerySchema.safeParse({ kind: 'nope' }).success).toBe(false)
    expect(RunsQuerySchema.safeParse({ kind: 'job,nope' }).success).toBe(false)
  })

  it('(f) rejects an empty kind=', () => {
    expect(RunsQuerySchema.safeParse({ kind: '' }).success).toBe(false)
  })

  it('(f) kind omitted → absent (no default filter)', () => {
    const r = RunsQuerySchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.kind).toBeUndefined()
  })
})

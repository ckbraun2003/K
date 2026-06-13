/**
 * Tests for server-side run filters: listRunsFiltered + RunsQuerySchema validation.
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, afterAll } from 'vitest'
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
    // At most 3 rows total
    expect(rows.length).toBeLessThanOrEqual(3)
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

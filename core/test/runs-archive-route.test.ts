/**
 * Lane B (B5, runs consolidation) — run archive/unarchive/clear-finished/permanent
 * delete + the GET /api/runs ?archived= filter.
 *
 * Archived-run membership lives in app_config (JSON set under key `runs.archived`,
 * see runsDb.archiveRun/unarchiveRun/isRunArchived/getArchivedRunIds) — NO
 * SCHEMA_VERSION bump. Builds the real Fastify app in-process (buildApp) and drives
 * it with app.inject; DB is the isolated per-worker K_DATA_DIR (vitest.config.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, runsDb, retryDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const seededRunIds: string[] = []
const seededArtifactSlugs: string[] = []

function insertRun(status: string, prompt = 'p'): string {
  const id = uuid()
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, prompt, '/tmp', status, Date.now())
  seededRunIds.push(id)
  return id
}

function seedDependents(runId: string): void {
  db.prepare(`INSERT INTO events (id, run_id, seq, type, ts) VALUES (?, ?, 0, 'message', ?)`)
    .run(uuid(), runId, Date.now())
  db.prepare(
    `INSERT INTO review_comments (id, run_id, file, line, side, body, status, created_at)
     VALUES (?, ?, 'a.ts', 1, 'new', 'fix it', 'draft', ?)`,
  ).run(uuid(), runId, Date.now())
  db.prepare(
    `INSERT INTO verify_results (run_id, status, reason, commands, scope, started_at, completed_at)
     VALUES (?, 'pass', NULL, '[]', NULL, ?, ?)`,
  ).run(runId, Date.now(), Date.now())
  db.prepare(
    `INSERT INTO run_plans (run_id, plan, raw, edited, profile_id, created_at, updated_at)
     VALUES (?, 'the plan', 'raw', 0, NULL, ?, ?)`,
  ).run(runId, Date.now(), Date.now())
}

function seedLinkedArtifact(runId: string): string {
  const slug = `runs-archive-art-${uuid().slice(0, 8)}`
  seededArtifactSlugs.push(slug)
  db.prepare(
    `INSERT INTO artifacts (slug, title, tags, linked_run_id, updated_at, md, origin) VALUES (?, 'Doc', '[]', ?, ?, '# x', 'compiled')`,
  ).run(slug, runId, Date.now())
  return slug
}

function countWhere(table: string, col: string, val: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(val) as { n: number }).n
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
}, 60_000) // cold module-graph import in isolation can exceed the 10s hook default (see runs-kind.test.ts)

afterAll(async () => {
  for (const slug of seededArtifactSlugs) {
    try { db.prepare(`DELETE FROM artifacts WHERE slug = ?`).run(slug) } catch { /* ignore */ }
  }
  for (const id of seededRunIds) {
    try { runsDb.unarchiveRun(id) } catch { /* ignore */ }
    for (const table of ['run_plans', 'review_comments', 'verify_results', 'events', 'runs']) {
      try { db.prepare(`DELETE FROM ${table} WHERE ${table === 'runs' ? 'id' : 'run_id'} = ?`).run(id) } catch { /* ignore */ }
    }
  }
  await app.close()
})

describe('POST /api/runs/:id/archive + /unarchive', () => {
  it('404 for an unknown run', async () => {
    const archive = await app.inject({ method: 'POST', url: `/api/runs/${uuid()}/archive`, headers: AUTH })
    expect(archive.statusCode).toBe(404)
    const unarchive = await app.inject({ method: 'POST', url: `/api/runs/${uuid()}/unarchive`, headers: AUTH })
    expect(unarchive.statusCode).toBe(404)
  })

  it('409 archiving a running or queued run', async () => {
    const running = insertRun('running')
    const blocked = await app.inject({ method: 'POST', url: `/api/runs/${running}/archive`, headers: AUTH })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toMatch(/running or queued/i)
    expect(runsDb.isRunArchived(running)).toBe(false)

    const queued = insertRun('queued')
    const blockedQ = await app.inject({ method: 'POST', url: `/api/runs/${queued}/archive`, headers: AUTH })
    expect(blockedQ.statusCode).toBe(409)
  })

  it('does NOT refuse a parked (awaiting_input / awaiting_plan) run — only running|queued', async () => {
    const parked = insertRun('awaiting_input')
    const res = await app.inject({ method: 'POST', url: `/api/runs/${parked}/archive`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: parked, archived: true })
    expect(runsDb.isRunArchived(parked)).toBe(true)
  })

  it('200 archives a finished run; unarchive reverses it', async () => {
    const runId = insertRun('done')
    const archive = await app.inject({ method: 'POST', url: `/api/runs/${runId}/archive`, headers: AUTH })
    expect(archive.statusCode).toBe(200)
    expect(archive.json()).toEqual({ id: runId, archived: true })
    expect(runsDb.isRunArchived(runId)).toBe(true)

    const unarchive = await app.inject({ method: 'POST', url: `/api/runs/${runId}/unarchive`, headers: AUTH })
    expect(unarchive.statusCode).toBe(200)
    expect(unarchive.json()).toEqual({ id: runId, archived: false })
    expect(runsDb.isRunArchived(runId)).toBe(false)
  })
})

describe('GET /api/runs — ?archived= filter', () => {
  const P = `archfilter-${Date.now()}`

  it('default (exclude) omits archived runs; ?archived=only / include work', async () => {
    const archived = insertRun('done', `${P} archived`)
    const active = insertRun('done', `${P} active`)
    runsDb.archiveRun(archived)

    async function fetchMine(qs: string) {
      const res = await app.inject({ method: 'GET', url: `/api/runs${qs}`, headers: AUTH })
      expect(res.statusCode).toBe(200)
      return (res.json() as Array<Record<string, unknown>>).filter(r => String(r.prompt).startsWith(P))
    }

    const byDefault = await fetchMine('?limit=500')
    expect(byDefault.map(r => r.id)).toEqual([active])

    const excluded = await fetchMine('?archived=exclude&limit=500')
    expect(excluded.map(r => r.id)).toEqual([active])

    const onlyArchived = await fetchMine('?archived=only&limit=500')
    expect(onlyArchived.map(r => r.id)).toEqual([archived])

    const both = await fetchMine('?archived=include&limit=500')
    expect(both.map(r => r.id).sort()).toEqual([active, archived].sort())

    runsDb.unarchiveRun(archived)
  })

  it('400 on an unrecognized ?archived= value', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?archived=bogus', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/runs/clear-finished', () => {
  it('archives done/error/killed but leaves running/queued/awaiting untouched', async () => {
    const done = insertRun('done')
    const errored = insertRun('error')
    const killed = insertRun('killed')
    const running = insertRun('running')
    const awaiting = insertRun('awaiting_input')

    const res = await app.inject({ method: 'POST', url: '/api/runs/clear-finished', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().archivedCount).toBe('number')
    expect(res.json().archivedCount).toBeGreaterThanOrEqual(3)

    expect(runsDb.isRunArchived(done)).toBe(true)
    expect(runsDb.isRunArchived(errored)).toBe(true)
    expect(runsDb.isRunArchived(killed)).toBe(true)
    expect(runsDb.isRunArchived(running)).toBe(false)
    expect(runsDb.isRunArchived(awaiting)).toBe(false)

    // re-running is a no-op on the same rows (idempotent set-add, no double count of these three)
    const again = await app.inject({ method: 'POST', url: '/api/runs/clear-finished', headers: AUTH })
    expect(again.statusCode).toBe(200)
  })
})

describe('DELETE /api/runs/:id', () => {
  it('404 for an unknown run', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${uuid()}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('409 deleting a running or queued run, even without checking archived state first', async () => {
    const running = insertRun('running')
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${running}`, headers: AUTH })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/running or queued/i)
  })

  it('409 deleting a finished run that is NOT archived (guard: archive first)', async () => {
    const runId = insertRun('done')
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}`, headers: AUTH })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/must be archived/i)
    expect(runsDb.getRun.get(runId)).toBeDefined() // still there
  })

  it('204 permanently removes an archived, finished run + cascades hard-FK dependents; nulls (does not delete) linked artifacts; drops it from the archived set', async () => {
    const runId = insertRun('done')
    seedDependents(runId)
    const artifactSlug = seedLinkedArtifact(runId)

    const archive = await app.inject({ method: 'POST', url: `/api/runs/${runId}/archive`, headers: AUTH })
    expect(archive.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    expect(del.body).toBe('')

    expect(runsDb.getRun.get(runId)).toBeUndefined()
    expect(countWhere('events', 'run_id', runId)).toBe(0)
    expect(countWhere('review_comments', 'run_id', runId)).toBe(0)
    expect(countWhere('verify_results', 'run_id', runId)).toBe(0)
    expect(countWhere('run_plans', 'run_id', runId)).toBe(0)
    expect(runsDb.isRunArchived(runId)).toBe(false)

    // dangling artifacts.linked_run_id (no FK on that column) is NULLED, not deleted —
    // the artifact row itself survives the run's permanent removal.
    const artifactRow = db.prepare(`SELECT linked_run_id FROM artifacts WHERE slug = ?`).get(artifactSlug) as
      | { linked_run_id: string | null }
      | undefined
    expect(artifactRow).toBeDefined()
    expect(artifactRow!.linked_run_id).toBeNull()
  })

  // Regression: runs.retry_of is a self-FK (TEXT REFERENCES runs(id), no ON DELETE
  // clause) — self-heal.ts (retryDb.setRunRetry) stamps a NEW run's retry_of to the
  // ORIGINAL failed run's id. Permanently deleting the ORIGINAL while a retry still
  // points at it must not throw SQLITE_CONSTRAINT_FOREIGNKEY; the dangling reference
  // must be nulled, mirroring nullDanglingArtifactLinks.
  it('204 deleting an archived run that is the ORIGINAL of a self-heal retry; nulls the retry\'s retry_of, retry row survives', async () => {
    const original = insertRun('done')
    const retryRun = insertRun('done', 'retry attempt')
    retryDb.setRunRetry.run({ id: retryRun, retryOf: original, retryCount: 1 })

    const archive = await app.inject({ method: 'POST', url: `/api/runs/${original}/archive`, headers: AUTH })
    expect(archive.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/api/runs/${original}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    expect(del.body).toBe('')

    expect(runsDb.getRun.get(original)).toBeUndefined()
    const retryRow = runsDb.getRun.get(retryRun) as { retry_of: string | null } | undefined
    expect(retryRow).toBeDefined()
    expect(retryRow!.retry_of).toBeNull()
  })
})

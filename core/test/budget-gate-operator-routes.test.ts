// core/test/budget-gate-operator-routes.test.ts — P5-FU-1: the budget park gates the
// operator ACTION routes with the same 429 payload as POST /api/runs. Under cap,
// each route proceeds past the gate (asserted as status !== 429 — downstream
// validation may still reject the minimal fixtures, which is fine and expected).
//
// Mirrors budget-gate-429.test.ts's proven arrangement: supervisor.startRun mocked
// (inserts a stub runs row, spawns nothing); the org cap set RELATIVE to current
// measured spend; scoped cleanup of every seeded id.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { budgetStatus } from '../src/budget-governor.js'
import { db } from '../src/db.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-bgop-run-${uuid().slice(0, 8)}`
      db.prepare(`INSERT OR IGNORE INTO runs (id, prompt, cwd, status, cost_usd, created_at)
                  VALUES (?, 'bgop', '.', 'queued', 0, ?)`).run(id, Date.now())
      return { id }
    }),
  }
})

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
let app: FastifyInstance
let runId: string
let projectId: string
let skillId: string
let repo: string
let headSha: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  app = await (await import('../src/index.js')).buildApp()

  // A real tmp repo so the rewind validation chain (sha-in-chain → cwd exists →
  // commit exists) passes and the request actually REACHES the budget gate.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-bgop-'))
  await execa('git', ['init', '-b', 'main', repo])
  await execa('git', ['-C', repo, 'config', 'user.email', 't@t.local'])
  await execa('git', ['-C', repo, 'config', 'user.name', 't'])
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n')
  await execa('git', ['-C', repo, 'add', '-A'])
  await execa('git', ['-C', repo, 'commit', '-m', 'base'])
  headSha = (await execa('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()

  projectId = uuid()
  db.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
    .run(projectId, `bgop-${projectId.slice(0, 8)}`, repo, Date.now())

  runId = `bgop-target-${uuid().slice(0, 8)}`
  db.prepare(`INSERT INTO runs (id, prompt, cwd, status, cost_usd, project_id, created_at)
              VALUES (?, 'orig', ?, 'done', 0.5, ?, ?)`).run(runId, repo, projectId, Date.now())
  // a checkpoint event whose sha is the repo HEAD → rewind's chain check passes
  db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, raw)
              VALUES (?, ?, 1, 'checkpoint', ?, ?)`)
    .run(uuid(), runId, Date.now(), JSON.stringify({ sha: headSha, tree: '', ref: `refs/k-checkpoints/${runId}`, wave: 1 }))
  // draft comment so request-changes passes its 409 guard and reaches the budget gate
  db.prepare(`INSERT INTO review_comments (id, run_id, file, line, side, body, status, created_at)
              VALUES (?, ?, 'a.ts', 1, 'new', 'fix', 'draft', ?)`).run(uuid(), runId, Date.now())
  // a real skill row so /trigger passes its existence 404 and reaches the gate
  skillId = uuid()
  db.prepare(`INSERT INTO skills (id, name, description, type, source, triggerType, schedule, eventTrigger, enabled, createdAt, qualified_key)
              VALUES (?, ?, 'bgop', 'skill', 'do nothing', 'manual', NULL, NULL, 1, ?, ?)`)
    .run(skillId, `bgop-skill-${skillId.slice(0, 8)}`, Date.now(), `k:bgop-${skillId.slice(0, 8)}`)
}, 60_000)
afterAll(async () => {
  setAutonomySettings({ orgDailyBudgetUsd: null }); __resetConfigCache()
  await app.close()
  db.prepare(`DELETE FROM review_comments WHERE run_id = ?`).run(runId)
  db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId)
  db.prepare(`DELETE FROM skill_runs WHERE skillId = ?`).run(skillId)
  db.prepare(`DELETE FROM skills WHERE id = ?`).run(skillId)
  db.prepare(`DELETE FROM work_items WHERE project_id = ?`).run(projectId)
  db.prepare(`DELETE FROM workflow_runs WHERE project_id = ?`).run(projectId)
  db.prepare(`DELETE FROM verification_reports WHERE project_id = ?`).run(projectId)
  db.prepare(`DELETE FROM runs WHERE id = ? OR id LIKE 'mock-bgop-run-%'`).run(runId)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

function capNow(): void {
  const spent = budgetStatus().org.spentUsd
  setAutonomySettings({ orgDailyBudgetUsd: Math.max(spent, 0.01) }) // spent >= cap ⇒ capped
  __resetConfigCache()
}
function uncap(): void { setAutonomySettings({ orgDailyBudgetUsd: null }); __resetConfigCache() }

const CASES: Array<{ name: string; url: () => string; payload?: unknown }> = [
  { name: 'rewind', url: () => `/api/runs/${runId}/rewind`, payload: () => ({ sha: headSha, prompt: 'p' }) as unknown },
  { name: 'request-changes', url: () => `/api/runs/${runId}/request-changes`, payload: {} },
  { name: 'deep verify', url: () => `/api/projects/${projectId}/verify`, payload: { deep: true } },
  { name: 'tasks/dispatch', url: () => `/api/projects/${projectId}/tasks/dispatch`, payload: { taskIds: [uuid()] } },
  { name: 'run-skill-now', url: () => `/api/skills/${'__SKILL__'}/trigger`, payload: {} },
] as Array<{ name: string; url: () => string; payload?: unknown }>

function resolvedCase(c: { name: string; url: () => string; payload?: unknown }): { url: string; payload: unknown } {
  const url = c.url().replace('__SKILL__', skillId)
  const payload = typeof c.payload === 'function' ? (c.payload as () => unknown)() : c.payload
  return { url, payload }
}

describe('P5-FU-1 budget park on operator action routes', () => {
  it.each(CASES)('$name → 429 with the dispatch payload shape when capped', async c => {
    capNow()
    const { url, payload } = resolvedCase(c)
    const res = await app.inject({ method: 'POST', url, headers: AUTH, payload })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'org budget cap reached', scope: 'org' })
    expect(typeof res.json().capUsd).toBe('number')
    expect(typeof res.json().spentUsd).toBe('number')
  })
  it.each(CASES)('$name → proceeds past the gate when under cap', async c => {
    uncap()
    const { url, payload } = resolvedCase(c)
    const res = await app.inject({ method: 'POST', url, headers: AUTH, payload })
    expect(res.statusCode).not.toBe(429)
  })
  it('plain deterministic verify (deep absent/false) is NEVER budget-gated', async () => {
    capNow()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/verify`, headers: AUTH, payload: {} })
    expect(res.statusCode).not.toBe(429)
    uncap()
  })
})

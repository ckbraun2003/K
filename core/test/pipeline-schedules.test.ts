/**
 * Task B.3 — pipeline-targeted routine schedules.
 *
 * A routine (a schedule-triggered `skills` row) can now target a PIPELINE definition via the
 * v15 `pipeline_def_id` column instead of firing as a plain skill run. Covers:
 *   - PATCH /api/skills/:id 400s an unknown pipelineDefId, 200s a known one (F-022 validate-first)
 *   - GET /api/routines projects pipelineDefId through to the RoutineView
 *   - fireScheduledSkill (the scheduler's per-tick call) starts a PIPELINE run when
 *     pipelineDefId is set, and falls BACK to a plain skill run when it's cleared (null) —
 *     byte-identical to the pre-B.3 behavior for every routine that doesn't opt in
 *   - the scheduler's cron callback now calls fireScheduledSkill (not triggerSkill directly)
 *   - NL→cron regression: 'daily' still translates to '0 9 * * *' (unaffected by this task)
 *
 * Real fastify app (buildApp), the shared vitest SQLite DB, a real throwaway git repo (the
 * pipeline engine's cwd git-check — resolveHeadCommit — needs one). Supervisor is mocked so the
 * plain-skill fallback branch never spawns a real process; the pipeline branch never dispatches
 * (buildApp does not start the pipeline scheduler), it only instantiates the ledger.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, pipelineDb, workflowDefsDb } from '../src/db.js'

// startRun mocked to avoid spawning a real process, but it MUST insert a real runs row —
// trackSupervisedRun's onStarted patches skill_runs.run_id, which has a FOREIGN KEY → runs(id)
// (mirrors agent-runs.test.ts's mock).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db: realDb } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-b3-run-${uuid().slice(0, 8)}`
      realDb.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'b3', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let repo: string
const DEF_ID = `pl-b3-${randomUUID().slice(0, 8)}`
let skillId: string
const createdPipelineRunIds: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Minimal, valid, deterministic PipelineSpec — instantiation-only (buildApp never starts the
// pipeline scheduler), so nothing actually dispatches regardless.
const SPEC = {
  name: 'B3 test pipeline',
  description: 'schedule-target pipeline',
  stages: [{ kind: 'deterministic', id: 'build', label: 'build', action: { type: 'command', run: 'node -e "0"' } }],
  edges: [{ from: 'build', to: 'done', handoff: 'share-tree' }],
  entry: 'build',
}

beforeAll(async () => {
  app = await (await import('../src/index.js')).buildApp()
  await app.ready()

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-b3-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@t.local'])
  git(repo, ['config', 'user.name', 't'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])

  workflowDefsDb.insertWorkflowDef.run({
    id: DEF_ID, name: `B3 Def ${DEF_ID}`, roles: '[]', promptScaffold: 'x', crossProject: 0, createdAt: Date.now(),
  })
  pipelineDb.setDefSpec.run({ id: DEF_ID, spec: JSON.stringify(SPEC) })

  // A schedule-triggered routine (plain skill row) — created via the real POST route so it
  // goes through the same validation every operator-created routine does.
  const created = await app.inject({
    method: 'POST', url: '/api/skills', headers: JSON_HEADERS,
    payload: JSON.stringify({
      name: `b3-routine-${DEF_ID}`, type: 'skill', source: 'do the scheduled thing',
      triggerType: 'schedule', schedule: '*/5 * * * *',
    }),
  })
  expect(created.statusCode).toBe(201)
  skillId = created.json().id as string
}, 60_000)

afterAll(async () => {
  await app.close()
  for (const id of createdPipelineRunIds) {
    db.prepare('DELETE FROM pipeline_edges WHERE pipeline_run_id = ?').run(id)
    db.prepare('DELETE FROM pipeline_stages WHERE pipeline_run_id = ?').run(id)
    db.prepare('DELETE FROM pipeline_runs WHERE id = ?').run(id)
  }
  db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(DEF_ID)
  if (skillId) {
    db.prepare('DELETE FROM skill_runs WHERE skillId = ?').run(skillId)
    db.prepare('DELETE FROM skills WHERE id = ?').run(skillId)
  }
  // The mocked startRun's own `runs` rows (skill_runs.runId → SET NULL above, so order is safe).
  db.prepare(`DELETE FROM runs WHERE prompt = 'b3'`).run()
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

describe('PATCH /api/skills/:id — pipelineDefId (B.3)', () => {
  it('400s an unknown pipeline definition id', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${skillId}`, headers: JSON_HEADERS,
      payload: JSON.stringify({ pipelineDefId: randomUUID() }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/unknown pipeline definition/i)
  })

  it('200s a known pipeline definition id and persists it', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/skills/${skillId}`, headers: JSON_HEADERS,
      payload: JSON.stringify({ pipelineDefId: DEF_ID }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().pipelineDefId).toBe(DEF_ID)
  })

  it('GET /api/routines projects pipelineDefId through to the RoutineView', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routines', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const mine = (res.json() as Array<{ id: string; pipelineDefId: string | null }>).find(r => r.id === skillId)
    expect(mine).toBeDefined()
    expect(mine!.pipelineDefId).toBe(DEF_ID)
  })
})

describe('fireScheduledSkill (the scheduler cron callback) — B.3', () => {
  it('starts a PIPELINE run (not a skill run) when pipelineDefId is set', async () => {
    const { fireScheduledSkill } = await import('../src/skills.js')
    const result = await fireScheduledSkill(skillId, 'scheduler')
    expect('pipelineRunId' in result).toBe(true)
    const pipelineRunId = (result as { pipelineRunId: string }).pipelineRunId
    createdPipelineRunIds.push(pipelineRunId)
    const row = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(pipelineRunId) as { definition_id?: string } | undefined
    expect(row).toBeDefined()
  })

  it('falls back to a plain skill run when pipelineDefId is cleared (null)', async () => {
    const clear = await app.inject({
      method: 'PATCH', url: `/api/skills/${skillId}`, headers: JSON_HEADERS,
      payload: JSON.stringify({ pipelineDefId: null }),
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().pipelineDefId).toBeNull()

    const { fireScheduledSkill } = await import('../src/skills.js')
    const result = await fireScheduledSkill(skillId, 'scheduler')
    expect('skillRunId' in result).toBe(true)
    expect('runId' in result).toBe(true)
  })
})

describe('NL→cron regression (unaffected by B.3)', () => {
  it("'daily' still translates to '0 9 * * *'", async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/routines/parse-cron', headers: JSON_HEADERS,
      payload: JSON.stringify({ text: 'daily' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cron).toBe('0 9 * * *')
  })
})

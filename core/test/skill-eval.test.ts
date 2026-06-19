/**
 * Skill eval-harness tests — pure helpers + POST/GET /api/skills/:id/{test,evals}.
 *
 * Same pattern as skills-route.test.ts: real Fastify app via buildApp (bootstrap
 * skipped), supervisor.startRun mocked so no real process spawns. Isolated DB via
 * vitest.config.ts K_DATA_DIR. Pure helpers are imported directly and unit-tested.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import { eventBus } from '../src/events.js'
import type { Skill, Run } from '@k/shared'
import {
  buildEvalPrompt,
  deriveEvalStatus,
  finalizeSkillEval,
} from '../src/skills.js'

// startRun is mocked to avoid spawning a real agent, but it MUST insert a real
// runs row: skill_evals.runId has a FOREIGN KEY → runs(id), and runSkillTest
// patches the eval's runId after dispatch.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = 'mock-eval-run'
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'eval', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const SFX = uuid().slice(0, 8)
const SKILL_NAME = `skill-eval-test-${SFX}`
let app: FastifyInstance
let skillId: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/api/skills',
    headers: AUTH,
    payload: { name: SKILL_NAME, type: 'skill', source: 'do the thing', triggerType: 'manual' },
  })
  skillId = res.json().id as string
})

afterAll(async () => {
  try { db.prepare('DELETE FROM skill_evals WHERE skillId = ?').run(skillId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM skills WHERE name = ?').run(SKILL_NAME) } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id = 'mock-eval-run'`).run() } catch { /* ignore */ }
  await app.close()
})

describe('deriveEvalStatus', () => {
  it('PASS marker beats status (even on a non-done terminal)', () => {
    expect(deriveEvalStatus('error', 'blah\nEVAL VERDICT: PASS')).toBe('pass')
  })
  it('FAIL marker beats status (even on done)', () => {
    expect(deriveEvalStatus('done', 'blah\nEVAL VERDICT: FAIL')).toBe('fail')
  })
  it('no marker + done → pass', () => {
    expect(deriveEvalStatus('done')).toBe('pass')
  })
  it('no marker + error/killed/interrupted → fail', () => {
    expect(deriveEvalStatus('error')).toBe('fail')
    expect(deriveEvalStatus('killed')).toBe('fail')
    expect(deriveEvalStatus('interrupted')).toBe('fail')
  })
})

describe('buildEvalPrompt', () => {
  it('contains the skill source and the verdict instruction', () => {
    const skill: Skill = {
      id: 'x', name: 'demo', type: 'skill', source: 'SUMMON-THE-SOURCE',
      triggerType: 'manual', schedule: null, eventTrigger: null, enabled: true, createdAt: 0,
    }
    const prompt = buildEvalPrompt(skill)
    expect(prompt).toContain('SUMMON-THE-SOURCE')
    expect(prompt).toContain('EVAL VERDICT: PASS')
    expect(prompt).toContain('EVAL VERDICT: FAIL')
  })
})

describe('POST /api/skills/:id/test + GET /api/skills/:id/evals', () => {
  it('202 with { evalId, runId }; the eval starts pending then finalizes via run_update', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/skills/${skillId}/test`, headers: AUTH })
    expect(res.statusCode).toBe(202)
    const { evalId, runId } = res.json()
    expect(typeof evalId).toBe('string')
    expect(runId).toBe('mock-eval-run')

    // First eval (no baseline): pending until the run terminates.
    const before = await app.inject({ method: 'GET', url: `/api/skills/${skillId}/evals`, headers: AUTH })
    const pending = (before.json() as Array<{ id: string; status: string }>).find(e => e.id === evalId)
    expect(pending?.status).toBe('pending')

    // Drive the live finalization path: emit a terminal run_update for the run.
    // runSkillTest's onRunUpdate subscription should set status pass, no regression.
    eventBus.emitRunUpdate({ id: 'mock-eval-run', status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const after = await app.inject({ method: 'GET', url: `/api/skills/${skillId}/evals`, headers: AUTH })
    const finalized = (after.json() as Array<{ id: string; status: string; regression: boolean; baselineEvalId: string | null }>).find(e => e.id === evalId)
    expect(finalized?.status).toBe('pass')
    expect(finalized?.regression).toBe(false)
    expect(finalized?.baselineEvalId).toBeNull()  // first eval — no prior baseline
  })

  it('404 on unknown skill id (test)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/skills/${uuid()}/test`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('404 on unknown skill id (evals)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/skills/${uuid()}/evals`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })
})

describe('regression detection via finalizeSkillEval', () => {
  it('flags regression when a prior pass becomes a fail', () => {
    // Isolate from evals created by earlier describe blocks in this file.
    db.prepare('DELETE FROM skill_evals WHERE skillId = ?').run(skillId)
    // Seed a prior completed PASS eval directly.
    const priorId = uuid()
    db.prepare(`
      INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
      VALUES (?, ?, NULL, 'pass', 0, NULL, ?, ?)
    `).run(priorId, skillId, Date.now() - 1000, Date.now() - 1000)

    // Insert the new pending eval, then finalize it as a fail.
    const newId = uuid()
    db.prepare(`
      INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
      VALUES (?, ?, NULL, 'pending', 0, NULL, ?, NULL)
    `).run(newId, skillId, Date.now())

    const result = finalizeSkillEval(newId, skillId, 'fail')
    expect(result.status).toBe('fail')
    expect(result.regression).toBe(true)
    expect(result.baselineEvalId).toBe(priorId)
  })

  it('no regression when prior was a fail', () => {
    db.prepare('DELETE FROM skill_evals WHERE skillId = ?').run(skillId)
    const priorId = uuid()
    db.prepare(`
      INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
      VALUES (?, ?, NULL, 'fail', 0, NULL, ?, ?)
    `).run(priorId, skillId, Date.now() - 1000, Date.now() - 1000)

    const newId = uuid()
    db.prepare(`
      INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
      VALUES (?, ?, NULL, 'pending', 0, NULL, ?, NULL)
    `).run(newId, skillId, Date.now())

    const result = finalizeSkillEval(newId, skillId, 'fail')
    expect(result.regression).toBe(false)
    expect(result.baselineEvalId).toBe(priorId)
  })
})

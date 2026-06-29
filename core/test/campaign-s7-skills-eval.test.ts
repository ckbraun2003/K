/**
 * Campaign S7 (LOCK / gating) — skill-eval recording, regression detection, and
 * clean no-dispatch degrade.
 *
 * EXTENDS skill-eval.test.ts (which covers pass→fail regression + fail→fail no-
 * regression + deriveEvalStatus + the route). This file locks the vectors that
 * file leaves open:
 *   - regression is NOT flagged for pass→pass or fail→pass (only a was-pass→now-fail).
 *   - the regression baseline is the most recent COMPLETED eval — a still-pending
 *     eval row is never used as a baseline.
 *   - runSkillTest degrades cleanly when there is NO dispatch (startRun throws):
 *     no crash, a durable 'fail' eval row, and an empty runId — not a leaked
 *     'pending' row.
 *
 * Do NOT perform real dispatches: startRun is mocked. skill_evals rows are seeded
 * directly to exercise the recording/regression LOGIC. Isolated K_DATA_DIR via
 * vitest.config.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'

// startRun mocked so no real agent spawns. On the SUCCESS path it inserts a real
// runs row (skill_evals.runId has a FK → runs(id)); the degrade test overrides it
// to reject so that path is never reached.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-s7-eval-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'eval', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { registerSkill, finalizeSkillEval, runSkillTest } = await import('../src/skills.js')
const { startRun } = await import('../src/supervisor.js')

let skillId: string
const SKILL_NAME = `s7-eval-skill-${uuid().slice(0, 8)}`

beforeAll(() => {
  skillId = registerSkill({ name: SKILL_NAME, type: 'skill', source: 'do the thing', triggerType: 'manual' }).id
})

afterAll(() => {
  try { db.prepare('DELETE FROM skill_evals WHERE skillId = ?').run(skillId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM skills WHERE id = ?').run(skillId) } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-s7-eval-%'`).run() } catch { /* ignore */ }
})

/** Seed a COMPLETED eval (pass|fail) and return its id. */
function seedCompleted(status: 'pass' | 'fail', ageMs: number): string {
  const id = uuid()
  const t = Date.now() - ageMs
  db.prepare(
    `INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
     VALUES (?, ?, NULL, ?, 0, NULL, ?, ?)`,
  ).run(id, skillId, status, t, t)
  return id
}
/** Seed a still-PENDING eval (no completedAt) and return its id. */
function seedPending(ageMs: number): string {
  const id = uuid()
  db.prepare(
    `INSERT INTO skill_evals (id, skillId, runId, status, regression, baselineEvalId, createdAt, completedAt)
     VALUES (?, ?, NULL, 'pending', 0, NULL, ?, NULL)`,
  ).run(id, skillId, Date.now() - ageMs)
  return id
}
function clearEvals(): void {
  db.prepare('DELETE FROM skill_evals WHERE skillId = ?').run(skillId)
}

// ── regression detection LOGIC ─────────────────────────────────────────────────

describe('finalizeSkillEval — regression flags only a was-pass → now-fail', () => {
  it('pass → pass is NOT a regression (baseline still linked)', () => {
    clearEvals()
    const prior = seedCompleted('pass', 2000)
    const cur = seedPending(0)
    const res = finalizeSkillEval(cur, skillId, 'pass')
    expect(res.status).toBe('pass')
    expect(res.regression).toBe(false)
    expect(res.baselineEvalId).toBe(prior)
  })

  it('fail → pass is NOT a regression (recovery)', () => {
    clearEvals()
    const prior = seedCompleted('fail', 2000)
    const cur = seedPending(0)
    const res = finalizeSkillEval(cur, skillId, 'pass')
    expect(res.regression).toBe(false)
    expect(res.baselineEvalId).toBe(prior)
  })

  it('a still-pending eval is never used as the baseline — only the prior COMPLETED pass counts', () => {
    clearEvals()
    const completedPass = seedCompleted('pass', 5000) // older, completed
    seedPending(2000)                                  // newer, but pending — must be ignored
    const cur = seedPending(0)                         // the one we finalize
    const res = finalizeSkillEval(cur, skillId, 'fail')
    // baseline resolves to the completed pass (not the newer pending row) → regression.
    expect(res.baselineEvalId).toBe(completedPass)
    expect(res.regression).toBe(true)
  })

  it('no prior completed eval → no baseline, no regression (first-ever fail)', () => {
    clearEvals()
    const cur = seedPending(0)
    const res = finalizeSkillEval(cur, skillId, 'fail')
    expect(res.baselineEvalId).toBeNull()
    expect(res.regression).toBe(false)
  })
})

// ── clean degrade when there is NO dispatch ────────────────────────────────────

describe('runSkillTest — graceful degrade when startRun throws (no dispatch)', () => {
  it('records a durable failed eval and returns an empty runId instead of crashing', async () => {
    clearEvals()
    vi.mocked(startRun).mockRejectedValueOnce(new Error('spawn ENOENT: claude not found'))

    // Must NOT throw out of runSkillTest — the degrade path swallows + records.
    const { evalId, runId } = await runSkillTest(skillId)
    expect(typeof evalId).toBe('string')
    expect(runId).toBe('') // no run was created

    // the eval row is durable + finalized 'fail' (not a leaked 'pending'), with a
    // completedAt timestamp; no baseline existed so no spurious regression.
    const row = db.prepare('SELECT status, completedAt, regression FROM skill_evals WHERE id = ?').get(evalId) as
      { status: string; completedAt: number | null; regression: number }
    expect(row.status).toBe('fail')
    expect(typeof row.completedAt).toBe('number')
    expect(row.regression).toBe(0)
  })
})

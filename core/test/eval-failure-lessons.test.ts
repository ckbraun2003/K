// core/test/eval-failure-lessons.test.ts — P5-FU-5: the eval runner records
// failure_reason; the E-27 gate groups on it alongside verify failures.
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db } from '../src/db.js'
import { recToEvalResultRow, deriveFailureReason } from '../src/eval/service.js'
import { collectRepeatedFailures } from '../src/lesson-proposals.js'
import type { EvalRecord } from '../src/eval/types.js'

const evalRunId = `elr-${randomUUID().slice(0, 8)}`
afterAll(() => {
  db.prepare(`DELETE FROM eval_results WHERE evalRunId = ?`).run(evalRunId)
  db.prepare(`DELETE FROM eval_runs WHERE id = ?`).run(evalRunId)
})

function rec(over: Partial<EvalRecord>): EvalRecord {
  return { jobKey: randomUUID(), system: 's', caseId: 'c', model: 'm', variant: 'real', ts: new Date().toISOString(), ...over } as EvalRecord
}

describe('deriveFailureReason', () => {
  it('error record → the error string; det fail → criticalFailures; pass → null', () => {
    expect(deriveFailureReason(rec({ error: 'boom at step 3' }))).toBe('boom at step 3')
    expect(deriveFailureReason(rec({ det: { detPass: false, detScore: 0, formatScore: 0, criticalFailures: ['missing file header'] } })))
      .toBe('missing file header')
    expect(deriveFailureReason(rec({ det: { detPass: false, detScore: 0, formatScore: 0, criticalFailures: [] } })))
      .toBe('deterministic grader fail')
    expect(deriveFailureReason(rec({ det: { detPass: true, detScore: 1, formatScore: 1, criticalFailures: [] } })))
      .toBeNull()
  })

  it('recToEvalResultRow carries the derived reason', () => {
    const row = recToEvalResultRow(evalRunId, rec({ error: 'kaboom' }))
    expect(row.failureReason).toBe('kaboom')
    const pass = recToEvalResultRow(evalRunId, rec({ det: { detPass: true, detScore: 1, formatScore: 1, criticalFailures: [] } }))
    expect(pass.failureReason).toBeNull()
  })
})

describe('E-27 gate reads eval failures', () => {
  it('repeated eval failure_reason rows group into a lesson candidate', () => {
    const now = Date.now()
    db.prepare(`INSERT INTO eval_runs (id, status, models, variants, systems, dry, totalJobs, completedJobs, totalCostUsd, report, error, createdAt, completedAt)
                VALUES (?, 'done', '[]', '[]', '[]', 0, 2, 2, 0, NULL, NULL, ?, ?)`).run(evalRunId, now, now)
    const ins = db.prepare(`INSERT INTO eval_results (id, evalRunId, systemId, caseId, model, variant, createdAt, failure_reason)
                            VALUES (?, ?, 's', 'c', 'm', 'real', ?, ?)`)
    ins.run(randomUUID(), evalRunId, now, 'timeout waiting for verify step 4')
    ins.run(randomUUID(), evalRunId, now, 'timeout waiting for verify step 9')
    const groups = collectRepeatedFailures(now)
    expect(groups.some(g => g.count >= 2 && /timeout waiting for verify step #/.test(g.signature))).toBe(true)
  })
})

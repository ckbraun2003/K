/**
 * Unit test for the run-lifecycle seam (run-lifecycle.ts::trackSupervisedRun).
 *
 * Pins the shared "supervised-run completion lifecycle" extracted (behavior-
 * preserving) from dispatchTaskWorkflow / triggerSkill / runSkillTest:
 *   - onStarted fires synchronously with the runId;
 *   - a terminal run-update event drives finalize exactly once;
 *   - the await/subscribe race is backstopped: a run already terminal at call
 *     time finalizes synchronously with no event;
 *   - finalize is latched at-most-once across the subscriber + backstop;
 *   - isTerminalRunStatus's terminal set.
 *
 * Isolates via the standard vitest.config.ts K_DATA_DIR — same as the other core
 * suites (just import db/runsDb/eventBus directly). Seeds real `runs` rows so the
 * backstop's DB re-read sees a true status.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import {
  trackSupervisedRun,
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
} from '../src/run-lifecycle.js'

/** Seed a real runs row at the given status; returns its id. */
function seedRun(status: string): string {
  const id = `rl-test-run-${uuid().slice(0, 8)}`
  runsDb.insertRun.run({
    id, prompt: 'run-lifecycle fixture', cwd: '.', worktree: null, status,
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: null, createdAt: Date.now(),
  })
  return id
}

afterAll(() => {
  db.prepare(`DELETE FROM runs WHERE id LIKE 'rl-test-run-%'`).run()
})

describe('trackSupervisedRun', () => {
  it('invokes onStarted synchronously with the runId', () => {
    const id = seedRun('running')
    const onStarted = vi.fn()
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted, finalize })
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(onStarted).toHaveBeenCalledWith(id)
  })

  it('subscribe → finalize: a terminal run-update finalizes once with that status', () => {
    const id = seedRun('running')
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted: vi.fn(), finalize })
    expect(finalize).not.toHaveBeenCalled()

    eventBus.emitRunUpdate({ id, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as any)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('done')
  })

  it('backstop: a run already terminal at call time finalizes synchronously, no event', () => {
    const id = seedRun('error')
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted: vi.fn(), finalize })
    // Finalized straight from the DB re-read — no emitRunUpdate needed.
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('error')
  })

  it('finalizes at most once: a second terminal event does not re-finalize', () => {
    const id = seedRun('running')
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted: vi.fn(), finalize })

    eventBus.emitRunUpdate({ id, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as any)
    eventBus.emitRunUpdate({ id, status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0 } as any)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('done')
  })

  it('backstop is idempotent: a late terminal event after a backstop finalize is ignored', () => {
    // Seed already-terminal so the backstop fires on the trackSupervisedRun call,
    // then emit another terminal event — the subscriber was unsubbed by the
    // backstop, so finalize must stay at exactly one (no late double-finalize).
    const id = seedRun('error')
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted: vi.fn(), finalize })
    expect(finalize).toHaveBeenCalledTimes(1)

    eventBus.emitRunUpdate({ id, status: 'killed', tokensIn: 0, tokensOut: 0, costUsd: 0 } as any)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('error')
  })

  it('ignores updates for other run ids', () => {
    const id = seedRun('running')
    const other = seedRun('running')
    const finalize = vi.fn()
    trackSupervisedRun(id, { onStarted: vi.fn(), finalize })

    eventBus.emitRunUpdate({ id: other, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as any)

    expect(finalize).not.toHaveBeenCalled()
  })
})

describe('isTerminalRunStatus / TERMINAL_RUN_STATUSES', () => {
  it('is true for the 4 terminal statuses', () => {
    for (const s of ['done', 'error', 'killed', 'interrupted']) {
      expect(isTerminalRunStatus(s)).toBe(true)
      expect(TERMINAL_RUN_STATUSES.has(s)).toBe(true)
    }
  })

  it('is false for non-terminal statuses and nullish values', () => {
    expect(isTerminalRunStatus('running')).toBe(false)
    expect(isTerminalRunStatus('queued')).toBe(false)
    expect(isTerminalRunStatus(null)).toBe(false)
    expect(isTerminalRunStatus(undefined)).toBe(false)
  })
})

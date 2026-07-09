/**
 * makeRunUpdateInvalidator — the run_update → invalidation policy (wave C1):
 *   - runs + metrics invalidate on EVERY run_update (today's behavior, preserved)
 *   - the org keys (chief-org / orchestrators / orchestrator-prefix) are THROTTLED:
 *     leading edge immediate, a burst inside the window coalesces into exactly ONE
 *     trailing invalidation at window close
 *   - non-run_update messages are ignored; dispose() cancels a pending trailing fire
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WsMessage } from '@k/shared'
import {
  makeRunUpdateInvalidator,
  makeProjectListInvalidator,
  makeWorkflowCompleteInvalidator,
} from '../src/lib/live-invalidate'

const runUpdate = { type: 'run_update', run: {} as never } as WsMessage
const otherMsg = { type: 'pong' } as WsMessage
const githubUpdate = { type: 'github_update', projectId: 'p1', kind: 'pr', payload: [] } as WsMessage
const terminalRunUpdate = { type: 'run_update', run: { status: 'done' } as never } as WsMessage
const runningRunUpdate = { type: 'run_update', run: { status: 'running' } as never } as WsMessage

const ORG_KEYS = ['chief-org', 'orchestrators', 'orchestrator'] as const
const K_KEYS = ['k-thread', 'k-notes', 'k-schedule', 'k-work-items'] as const

function keyCounts(spy: ReturnType<typeof vi.fn>) {
  const counts: Record<string, number> = {}
  for (const call of spy.mock.calls) {
    const key = (call[0] as { queryKey: unknown[] }).queryKey[0] as string
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('makeRunUpdateInvalidator', () => {
  it('one run_update invalidates runs, metrics, and all three org keys once', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries })

    handler(runUpdate)

    const counts = keyCounts(invalidateQueries)
    expect(counts.runs).toBe(1)
    expect(counts.metrics).toBe(1)
    for (const key of ORG_KEYS) expect(counts[key]).toBe(1)
    dispose()
  })

  it('a burst of 5 inside the window → runs/metrics ×5, each org key exactly ×2 (leading + one trailing)', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries }, 250)

    for (let i = 0; i < 5; i++) handler(runUpdate)

    // Before the window closes: org keys have only the leading fire.
    let counts = keyCounts(invalidateQueries)
    expect(counts.runs).toBe(5)
    expect(counts.metrics).toBe(5)
    for (const key of ORG_KEYS) expect(counts[key]).toBe(1)

    // Window closes → exactly ONE trailing org invalidation lands.
    vi.advanceTimersByTime(251)
    counts = keyCounts(invalidateQueries)
    expect(counts.runs).toBe(5)
    for (const key of ORG_KEYS) expect(counts[key]).toBe(2)

    // Nothing else pending.
    vi.advanceTimersByTime(1000)
    expect(keyCounts(invalidateQueries)[ORG_KEYS[0]]).toBe(2)
    dispose()
  })

  it('ignores non-run_update messages', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries })

    handler(otherMsg)

    expect(invalidateQueries).not.toHaveBeenCalled()
    dispose()
  })

  it('dispose cancels a pending trailing fire', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries }, 250)

    handler(runUpdate) // leading
    handler(runUpdate) // queues the trailing fire
    dispose()

    vi.advanceTimersByTime(1000)
    for (const key of ORG_KEYS) expect(keyCounts(invalidateQueries)[key]).toBe(1)
  })

  // ── F-059: a TERMINAL run refreshes the K-home surfaces ──
  it('a terminal run_update invalidates the K-home surface keys (F-059)', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries })

    handler(terminalRunUpdate)

    const counts = keyCounts(invalidateQueries)
    // A completed run writes items + a k-turn — the K-home reads refresh live.
    for (const key of K_KEYS) expect(counts[key]).toBe(1)
    // The pre-existing per-message invalidations still fire.
    expect(counts.runs).toBe(1)
    expect(counts.metrics).toBe(1)
    dispose()
  })

  it('a NON-terminal run_update does NOT invalidate the K-home keys (only on settle)', () => {
    const invalidateQueries = vi.fn()
    const { handler, dispose } = makeRunUpdateInvalidator({ invalidateQueries })

    handler(runningRunUpdate)

    const counts = keyCounts(invalidateQueries)
    for (const key of K_KEYS) expect(counts[key]).toBeUndefined()
    // runs/metrics still invalidate per message regardless of status.
    expect(counts.runs).toBe(1)
    dispose()
  })
})

describe('makeProjectListInvalidator (F-036)', () => {
  it('a github_update invalidates the projects list + fleet-github batch', () => {
    const invalidateQueries = vi.fn()
    const handler = makeProjectListInvalidator({ invalidateQueries })

    handler(githubUpdate)

    const counts = keyCounts(invalidateQueries)
    expect(counts.projects).toBe(1)
    expect(counts['github-fleet']).toBe(1)
  })

  it('ignores run_update and other non-github messages', () => {
    const invalidateQueries = vi.fn()
    const handler = makeProjectListInvalidator({ invalidateQueries })

    handler(runUpdate)
    handler(otherMsg)

    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})

describe('makeWorkflowCompleteInvalidator (F-076)', () => {
  const workflowComplete = {
    type: 'workflow_complete', workflowRunId: 'wf1', projectId: 'p9',
    status: 'completed', taskIds: ['t1', 't2'],
  } as WsMessage
  const emptyWorkflowComplete = {
    type: 'workflow_complete', workflowRunId: 'wf2', projectId: 'p9',
    status: 'completed', taskIds: [],
  } as WsMessage

  it('invalidates the project task list + workflow-runs on a task-workflow completion', () => {
    const invalidateQueries = vi.fn()
    const handler = makeWorkflowCompleteInvalidator({ invalidateQueries })

    handler(workflowComplete)

    // ['tasks', projectId] — the scoped key the project's Tasks tab reads.
    const tasksCall = invalidateQueries.mock.calls.find(
      c => (c[0] as { queryKey: unknown[] }).queryKey[0] === 'tasks',
    )
    expect((tasksCall?.[0] as { queryKey: unknown[] }).queryKey).toEqual(['tasks', 'p9'])
    const counts = keyCounts(invalidateQueries)
    expect(counts['workflow-runs']).toBe(1)
  })

  it('ignores a workflow_complete with no tasks (a lead workflow run) + non-matching messages', () => {
    const invalidateQueries = vi.fn()
    const handler = makeWorkflowCompleteInvalidator({ invalidateQueries })

    handler(emptyWorkflowComplete)
    handler(runUpdate)
    handler(otherMsg)

    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})

// ── makeInboxInvalidator (P2 B3 — E-05/E-19) ──────────────────────────────────
// Appended by Lane B: any needs-YOU source may have changed → refresh the ONE
// ['inbox'] query (badge + page share it); a `notification` also refreshes the
// ['notifications'] center. Reuses the module-scope keyCounts / message fixtures.
import { makeInboxInvalidator } from '../src/lib/live-invalidate'

const notificationMsg = { type: 'notification', notification: {} as never, browser: false } as WsMessage
const capabilitiesUpdate = { type: 'capabilities_update', scannedAt: 0 } as WsMessage

describe('makeInboxInvalidator (E-05/E-19)', () => {
  it('a run_update refreshes the inbox query only (not the notification center)', () => {
    const invalidateQueries = vi.fn()
    const handler = makeInboxInvalidator({ invalidateQueries })

    handler(runUpdate)

    const counts = keyCounts(invalidateQueries)
    expect(counts.inbox).toBe(1)
    expect(counts.notifications).toBeUndefined()
  })

  it('a notification refreshes BOTH the inbox query and the notification center', () => {
    const invalidateQueries = vi.fn()
    const handler = makeInboxInvalidator({ invalidateQueries })

    handler(notificationMsg)

    const counts = keyCounts(invalidateQueries)
    expect(counts.inbox).toBe(1)
    expect(counts.notifications).toBe(1)
  })

  it('a capabilities_update refreshes the inbox query only', () => {
    const invalidateQueries = vi.fn()
    const handler = makeInboxInvalidator({ invalidateQueries })

    handler(capabilitiesUpdate)

    const counts = keyCounts(invalidateQueries)
    expect(counts.inbox).toBe(1)
    expect(counts.notifications).toBeUndefined()
  })

  it('ignores unrelated messages (e.g. pong)', () => {
    const invalidateQueries = vi.fn()
    const handler = makeInboxInvalidator({ invalidateQueries })

    handler(otherMsg)

    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})

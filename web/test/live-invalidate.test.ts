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
import { makeRunUpdateInvalidator, makeProjectListInvalidator } from '../src/lib/live-invalidate'

const runUpdate = { type: 'run_update', run: {} as never } as WsMessage
const otherMsg = { type: 'pong' } as WsMessage
const githubUpdate = { type: 'github_update', projectId: 'p1', kind: 'pr', payload: [] } as WsMessage

const ORG_KEYS = ['chief-org', 'orchestrators', 'orchestrator'] as const

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

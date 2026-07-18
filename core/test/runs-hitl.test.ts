/**
 * Wave A3 — interactive multi-turn HITL: supervisor failure modes.
 *
 * Live smoke (A3.0) confirmed Strategy 1 holds: a single `claude` process keeps
 * stdin open across turns and `{type:"result"}` marks the awaiting-input boundary.
 * These are the unit tests for the four edge cases the plan requires — exercised
 * WITHOUT spawning a real CLI by seeding a fake interactive process via the
 * supervisor's `__testHooks` seam and real run rows via runsDb.
 *
 *   1. proc-exits-while-awaiting  — sendInput → false (no live proc / wrong status)
 *   2. double-send                — second sendInput after the run left awaiting → false
 *   3. killed-while-awaiting EPIPE — a throwing stdin.write is swallowed → false (no throw)
 *   4. idle-timeout               — a parked run past INTERACTIVE_IDLE_MS ends the session
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { runsDb } from '../src/db.js'
import { sendInput, endSession, __testHooks } from '../src/supervisor.js'

const seeded: string[] = []

/** Insert a real run row in the given status; track it for cleanup. */
function seedRun(status: string): string {
  const id = uuid()
  runsDb.insertRun.run({
    id, prompt: 'p', cwd: '/tmp', worktree: null, status,
    provider: 'claude', model: 'claude-haiku-4-5-20251001',
    tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now(),
  })
  seeded.push(id)
  return id
}

/** A minimal fake interactive ActiveProc with a spy-able stdin. */
function fakeProc(opts: { writeThrows?: boolean } = {}) {
  const writes: string[] = []
  let ended = false
  return {
    proc: {
      kill: vi.fn(),
      interactive: true,
      stdin: {
        write(s: string) {
          if (opts.writeThrows) { const e = new Error('write EPIPE') as NodeJS.ErrnoException; e.code = 'EPIPE'; throw e }
          writes.push(s); return true
        },
        end() { ended = true },
      } as unknown as NodeJS.WritableStream,
    },
    writes,
    get ended() { return ended },
  }
}

afterEach(() => {
  for (const id of seeded.splice(0)) {
    __testHooks.clearActiveProc(id)
    try { runsDb.updateRunStatus.run({ id, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0, endedAt: Date.now() }) } catch { /* ignore */ }
  }
  vi.useRealTimers()
})

describe('sendInput — interactive HITL failure modes', () => {
  it('1. proc-exits-while-awaiting: returns false when there is no live interactive process', () => {
    const id = seedRun('awaiting_input') // row says awaiting, but NO active proc registered
    expect(sendInput(id, 'answer')).toBe(false)
  })

  it('returns false when an active proc exists but the run is NOT awaiting_input', () => {
    const id = seedRun('running')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    expect(sendInput(id, 'answer')).toBe(false)
    expect(fake.writes).toHaveLength(0) // never wrote to stdin
  })

  it('accepts the turn and writes the exact envelope when awaiting_input', () => {
    const id = seedRun('awaiting_input')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    expect(sendInput(id, 'my answer')).toBe(true)
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]).toBe(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'my answer' } }) + '\n',
    )
  })

  it('2. double-send: the second send is rejected (run is no longer awaiting after the first)', () => {
    const id = seedRun('awaiting_input')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    // First send accepted → flips the run to 'running' in the DB.
    expect(sendInput(id, 'first')).toBe(true)
    // Second send (stale/concurrent client) → run is 'running', not 'awaiting_input' → 409 path.
    expect(sendInput(id, 'second')).toBe(false)
    expect(fake.writes).toHaveLength(1) // only the first turn reached stdin
  })

  it('3. killed-while-awaiting EPIPE: a throwing stdin.write is swallowed and returns false', () => {
    const id = seedRun('awaiting_input')
    const fake = fakeProc({ writeThrows: true })
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    // Child died between the status check and the write — must NOT throw.
    expect(() => sendInput(id, 'answer')).not.toThrow()
    expect(sendInput(id, 'answer')).toBe(false)
  })

  it('returns false for an unknown run id (no row, no proc)', () => {
    expect(sendInput(uuid(), 'answer')).toBe(false)
  })

  it('3b. ending-while-awaiting: a send after endSession is REFUSED — no silent write-after-end (A.2 demote window)', () => {
    const id = seedRun('awaiting_input')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    // Graceful close (idle timer / session demote / operator end): stdin is
    // end()'d but the row stays awaiting_input until the CLI exits. A write in
    // that window fails ASYNCHRONOUSLY (ERR_STREAM_WRITE_AFTER_END) — the sync
    // catch never sees it, so an unguarded send would report true while the
    // text reached nobody. sendInput must refuse so the session layer queues
    // the body for its terminal re-dispatch.
    expect(endSession(id)).toBe(true)
    expect(fake.ended).toBe(true)
    expect(sendInput(id, 'late body')).toBe(false)
    expect(fake.writes).toHaveLength(0) // nothing was written to the dead stdin
  })
})

describe('idle-timeout — a parked run ends its session', () => {
  it('4. fires endSession after INTERACTIVE_IDLE_MS, closing stdin', () => {
    vi.useFakeTimers()
    const id = seedRun('awaiting_input')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    __testHooks.armIdleTimer(id)
    expect(__testHooks.hasIdleTimer(id)).toBe(true)

    // Advance past the default 10-minute idle window → idle timer fires endSession.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)

    expect(fake.ended).toBe(true)              // stdin was end()'d (EOF → agent finishes)
    expect(__testHooks.hasIdleTimer(id)).toBe(false) // timer cleared by endSession
  })

  it('endSession returns false for a non-interactive / already-gone run', () => {
    const id = seedRun('awaiting_input') // no active proc registered
    expect(endSession(id)).toBe(false)
  })

  it('a delivered turn clears the idle timer (operator answered in time)', () => {
    const id = seedRun('awaiting_input')
    const fake = fakeProc()
    __testHooks.initSeq(id)
    __testHooks.setActiveProc(id, fake.proc)
    __testHooks.armIdleTimer(id)
    expect(__testHooks.hasIdleTimer(id)).toBe(true)
    expect(sendInput(id, 'answer')).toBe(true)
    expect(__testHooks.hasIdleTimer(id)).toBe(false) // sendInput cleared it
  })
})

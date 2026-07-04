/**
 * fix-c — `/end` (endSession) on a NON-interactive supervised run.
 *
 * A relay-dispatched LEAD run is supervised in the MAIN process (startLeadDispatchRelay →
 * startAgentRun → startRun → runAgent), so its child sits in `activeProcesses` exactly like
 * any run — which is why `/kill` (kill()) already flipped its status. But `endSession` used to
 * early-return false for ANY non-interactive run, so `/end` was a NO-OP and the run's status
 * stayed stuck. endSession now routes a non-interactive run through the same kill() path so
 * `/end` transitions it to a terminal status (→ 'killed' via runAgent's exit handler — the
 * same live-proven mechanism /kill uses; a mid-work run did not complete, so 'killed' is the
 * honest status, not a misleading 'done'). The interactive graceful-EOF path is unchanged.
 *
 * These exercise endSession directly via the supervisor's __testHooks seam (no real CLI).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { endSession, __testHooks } from '../src/supervisor.js'

const seeded: string[] = []

/** Register a fake NON-interactive supervised process (a relay lead run) with a kill spy. */
function fakeLeadProc() {
  const proc = { kill: vi.fn(), interactive: false }
  const id = uuid()
  __testHooks.setActiveProc(id, proc)
  seeded.push(id)
  return { id, proc }
}

/** Register a fake INTERACTIVE process with a spy-able stdin (the unchanged path). */
function fakeInteractiveProc() {
  let ended = false
  const proc = {
    kill: vi.fn(),
    interactive: true,
    stdin: { end() { ended = true }, write() { return true } } as unknown as NodeJS.WritableStream,
  }
  const id = uuid()
  __testHooks.setActiveProc(id, proc)
  seeded.push(id)
  return { id, proc, get ended() { return ended } }
}

afterEach(() => {
  for (const id of seeded.splice(0)) __testHooks.clearActiveProc(id)
  vi.useRealTimers()
})

describe('endSession — non-interactive relay-dispatched lead run (fix-c)', () => {
  it('now ACTS (returns true) and signals a graceful SIGTERM — previously it no-op\'d (false)', () => {
    const { id, proc } = fakeLeadProc()
    expect(endSession(id)).toBe(true)                    // was false before the fix
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')    // reaches the run via /kill's path
  })

  it('escalates to SIGKILL if the child ignores SIGTERM (so it always reaches terminal)', () => {
    vi.useFakeTimers()
    const { id, proc } = fakeLeadProc()
    expect(endSession(id)).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    // The child is still registered (never exited) → the escalation timer fires SIGKILL.
    vi.advanceTimersByTime(3000)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    // (The DB status flip to 'killed' rides runAgent's exit handler — the same mechanism
    //  /kill uses and that the live smokes proved; not reachable with a fake process here.)
  })
})

describe('endSession — interactive session path is UNCHANGED', () => {
  it('closes stdin (graceful EOF → agent finishes → done) and does NOT signal-kill', () => {
    const iact = fakeInteractiveProc()
    expect(endSession(iact.id)).toBe(true)
    expect(iact.ended).toBe(true)              // stdin.end() called (EOF)
    expect(iact.proc.kill).not.toHaveBeenCalled() // no immediate signal on the graceful path
  })

  it('an interactive proc that already lost its stdin is a no-op (false, no signal) — scope lock', () => {
    // The fix-c kill() path is scoped to genuinely NON-interactive procs; an interactive proc
    // with no stdin stays the original no-op, NOT routed to kill().
    const proc = { kill: vi.fn(), interactive: true } // interactive, but no stdin
    const id = uuid()
    __testHooks.setActiveProc(id, proc)
    seeded.push(id)
    expect(endSession(id)).toBe(false)
    expect(proc.kill).not.toHaveBeenCalled()
  })
})

describe('endSession — already-gone run', () => {
  it('returns false when there is no live process (unchanged)', () => {
    expect(endSession(uuid())).toBe(false)
  })
})

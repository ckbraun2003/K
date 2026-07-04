/**
 * F-088 — suppress node-pty's benign ConPTY teardown noise (`Error: AttachConsole
 * failed` from the forked `conpty_console_list_agent` helper) WITHOUT broadly swallowing
 * stderr.
 *
 * The predicate is the unit-locked contract: only the node-pty helper's output matches;
 * any real error passes through. The filter wrapper drops a matched chunk (honoring a
 * completion callback) and forwards everything else to the original write verbatim.
 */
import { describe, it, expect } from 'vitest'
import { isBenignConptyNoise, makeFilteredStderrWrite } from '../src/terminal.js'

describe('isBenignConptyNoise (F-088 predicate)', () => {
  it('matches the exact AttachConsole failed error', () => {
    expect(isBenignConptyNoise('Error: AttachConsole failed')).toBe(true)
  })

  it('matches a stack frame from the conpty helper (chunks can split the message)', () => {
    expect(
      isBenignConptyNoise('    at Object.<anonymous> (C:/…/node-pty/lib/conpty_console_list_agent.js:13:26)'),
    ).toBe(true)
  })

  it('does NOT match a real error (a real error passes through)', () => {
    expect(isBenignConptyNoise('Error: ECONNREFUSED 127.0.0.1:3001')).toBe(false)
    expect(isBenignConptyNoise('SqliteError: database is locked')).toBe(false)
    expect(isBenignConptyNoise('TypeError: cannot read properties of undefined')).toBe(false)
    // Superficially similar but NOT the benign message.
    expect(isBenignConptyNoise('AttachConsole succeeded')).toBe(false)
  })
})

describe('makeFilteredStderrWrite (F-088 narrow filter)', () => {
  it('drops benign conpty noise and does NOT call the original (string + Buffer)', () => {
    const seen: unknown[] = []
    const write = makeFilteredStderrWrite((chunk: unknown) => { seen.push(chunk); return true })

    expect(write('Error: AttachConsole failed\n')).toBe(true)
    expect(write(Buffer.from('  at conpty_console_list_agent.js:13\n'))).toBe(true)
    expect(seen).toHaveLength(0) // both dropped — original never invoked
  })

  it('passes a real error through to the original with identical args + return value', () => {
    const calls: unknown[][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const write = makeFilteredStderrWrite((...args: any[]) => { calls.push(args); return false })

    const ret = write('Error: real boom\n', 'utf8')

    expect(ret).toBe(false)
    expect(calls).toEqual([['Error: real boom\n', 'utf8']])
  })

  it('invokes the completion callback when it drops a chunk (caller never hangs)', () => {
    let called = false
    const write = makeFilteredStderrWrite(() => true)
    write('AttachConsole failed', () => { called = true })
    expect(called).toBe(true)
  })
})

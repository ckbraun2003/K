/**
 * Web terminal core — gate + session, with a FAKE pty.
 *
 * These tests never spawn a real node-pty (CI stays deterministic/fast): the
 * session's spawn is injected, so we capture the pty callbacks and assert the
 * frame protocol both ways.
 */
import { describe, it, expect, vi } from 'vitest'
import { terminalGate, createTerminalSession, type PtyLike } from '../src/terminal.js'

describe('terminalGate', () => {
  const expectedToken = 'secret'

  it('rejects when disabled (even with a correct token)', () => {
    expect(terminalGate({ enabled: false, token: 'secret', expectedToken })).toEqual({
      ok: false,
      code: 'disabled',
    })
  })

  it('rejects a missing or empty token as unauthorized', () => {
    expect(terminalGate({ enabled: true, token: undefined, expectedToken })).toEqual({
      ok: false,
      code: 'unauthorized',
    })
    expect(terminalGate({ enabled: true, token: '', expectedToken })).toEqual({
      ok: false,
      code: 'unauthorized',
    })
  })

  it('rejects a wrong token as unauthorized', () => {
    expect(terminalGate({ enabled: true, token: 'nope', expectedToken })).toEqual({
      ok: false,
      code: 'unauthorized',
    })
  })

  it('allows when enabled and token matches', () => {
    expect(terminalGate({ enabled: true, token: 'secret', expectedToken })).toEqual({ ok: true })
  })
})

/** A fake pty that records callbacks + calls so tests can drive it. */
function makeFakePty() {
  const calls = {
    writes: [] as string[],
    resizes: [] as Array<{ cols: number; rows: number }>,
    killed: 0,
  }
  let dataCb: ((d: string) => void) | undefined
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  const pty: PtyLike = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    write: (d) => { calls.writes.push(d) },
    resize: (cols, rows) => { calls.resizes.push({ cols, rows }) },
    kill: () => { calls.killed += 1 },
  }
  return {
    pty,
    calls,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (exitCode: number) => exitCb?.({ exitCode }),
  }
}

describe('createTerminalSession', () => {
  it('spawns a pty and forwards output as frames', () => {
    const fake = makeFakePty()
    const send = vi.fn()
    createTerminalSession({ send, spawn: () => fake.pty })

    fake.emitData('hello')
    expect(send).toHaveBeenCalledWith({ type: 'output', data: 'hello' })
  })

  it('routes an input frame to pty.write', () => {
    const fake = makeFakePty()
    const session = createTerminalSession({ send: vi.fn(), spawn: () => fake.pty })

    session.onClientMessage(JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(fake.calls.writes).toEqual(['ls\r'])
  })

  it('routes a resize frame to pty.resize', () => {
    const fake = makeFakePty()
    const session = createTerminalSession({ send: vi.fn(), spawn: () => fake.pty })

    session.onClientMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    expect(fake.calls.resizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('ignores malformed and unknown frames without throwing', () => {
    const fake = makeFakePty()
    const session = createTerminalSession({ send: vi.fn(), spawn: () => fake.pty })

    expect(() => session.onClientMessage('not json')).not.toThrow()
    expect(() => session.onClientMessage('null')).not.toThrow()
    expect(() => session.onClientMessage(JSON.stringify({ type: 'bogus' }))).not.toThrow()
    expect(() => session.onClientMessage(JSON.stringify({ type: 'input' }))).not.toThrow()
    expect(fake.calls.writes).toEqual([])
    expect(fake.calls.resizes).toEqual([])
  })

  it('emits an exit frame when the pty exits', () => {
    const fake = makeFakePty()
    const send = vi.fn()
    createTerminalSession({ send, spawn: () => fake.pty })

    fake.emitExit(0)
    expect(send).toHaveBeenCalledWith({ type: 'exit', exitCode: 0 })
  })

  it('disposes by killing the pty, idempotently', () => {
    const fake = makeFakePty()
    const session = createTerminalSession({ send: vi.fn(), spawn: () => fake.pty })

    session.dispose()
    session.dispose()
    expect(fake.calls.killed).toBe(1)
  })

  it('does not throw if pty.kill() throws (Windows already-exited)', () => {
    const fake = makeFakePty()
    fake.pty.kill = () => { throw new Error('process already exited') }
    const session = createTerminalSession({ send: vi.fn(), spawn: () => fake.pty })

    expect(() => session.dispose()).not.toThrow()
  })
})

/**
 * Web terminal core — gate + session, with a FAKE pty.
 *
 * These tests never spawn a real node-pty (CI stays deterministic/fast): the
 * session's spawn is injected, so we capture the pty callbacks and assert the
 * frame protocol both ways.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  terminalGate,
  createTerminalSession,
  isSensitiveEnvName,
  scrubSensitiveEnv,
  type PtyLike,
} from '../src/terminal.js'

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

describe('scrubSensitiveEnv (F-084 pty env scrub)', () => {
  it('drops credential-bearing vars but keeps PATH/HOME and other safe vars', () => {
    const scrubbed = scrubSensitiveEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/k',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-should-be-gone',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-gone',
      HARNESS_TOKEN: 'harness-gone',
      TERMINAL_TOKEN: 'terminal-gone',
      FOO_TOKEN: 'foo-gone',
      MY_API_KEY: 'key-gone',
      DB_PASSWORD: 'pw-gone',
      AWS_SECRET_ACCESS_KEY: 'aws-gone',
      GH_TOKEN: 'gh-gone',
      GITHUB_TOKEN: 'ghp-gone',
      NPM_TOKEN: 'npm-gone',
    })
    // Safe vars survive.
    expect(scrubbed.PATH).toBe('/usr/bin:/bin')
    expect(scrubbed.HOME).toBe('/home/k')
    expect(scrubbed.SystemRoot).toBe('C:\\Windows')
    expect(scrubbed.TERM).toBe('xterm-256color')
    expect(scrubbed.LANG).toBe('en_US.UTF-8')
    // Every credential-shaped var is stripped.
    for (const k of [
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HARNESS_TOKEN', 'TERMINAL_TOKEN',
      'FOO_TOKEN', 'MY_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN',
      'GITHUB_TOKEN', 'NPM_TOKEN',
    ]) {
      expect(scrubbed[k], k).toBeUndefined()
    }
    // No stripped secret value survives anywhere in the scrubbed env.
    const values = Object.values(scrubbed).join('\n')
    expect(values).not.toMatch(/gone/)
  })

  it('matches sensitive names case-insensitively (Windows env names)', () => {
    expect(isSensitiveEnvName('anthropic_api_key')).toBe(true)
    expect(isSensitiveEnvName('Harness_Token')).toBe(true)
    expect(isSensitiveEnvName('terminal_token')).toBe(true)
    // Plain non-secret vars are not flagged.
    expect(isSensitiveEnvName('PATH')).toBe(false)
    expect(isSensitiveEnvName('HOME')).toBe(false)
    expect(isSensitiveEnvName('PATHEXT')).toBe(false)
    expect(isSensitiveEnvName('K_DATA_DIR')).toBe(false)
  })

  it('drops connection-string / DSN / shorthand-password vars but keeps non-cred siblings', () => {
    const scrubbed = scrubSensitiveEnv({
      PATH: '/usr/bin',
      HOME: '/home/k',
      DATABASE_HOST: 'db.internal', // NON-cred host — must survive
      PWD: '/home/k/project',       // POSIX cwd var — must survive (not `_PWD`)
      DATABASE_URL: 'postgres://user:pass@db:5432/app',
      REDIS_URL: 'redis://:secret@cache:6379',
      MONGODB_URI: 'mongodb://user:pass@mongo:27017',
      SENTRY_DSN: 'https://key@sentry.io/1',
      FOO_DSN: 'x',
      DB_PASS: 'hunter2',
      DB_PWD: 'hunter2',
      APP_CONNECTION_STRING: 'Server=x;Password=y',
    })
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/home/k')
    expect(scrubbed.DATABASE_HOST).toBe('db.internal')
    expect(scrubbed.PWD).toBe('/home/k/project')
    for (const k of [
      'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'SENTRY_DSN', 'FOO_DSN',
      'DB_PASS', 'DB_PWD', 'APP_CONNECTION_STRING',
    ]) {
      expect(scrubbed[k], k).toBeUndefined()
    }
    // Bare `PWD` is preserved (only `_PWD` matches).
    expect(isSensitiveEnvName('PWD')).toBe(false)
    expect(isSensitiveEnvName('DB_PWD')).toBe(true)
    expect(isSensitiveEnvName('DATABASE_HOST')).toBe(false)
  })

  it('drops undefined values (NodeJS.ProcessEnv holes) without keeping them', () => {
    const scrubbed = scrubSensitiveEnv({ PATH: '/bin', UNSET: undefined })
    expect(scrubbed.PATH).toBe('/bin')
    expect('UNSET' in scrubbed).toBe(false)
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

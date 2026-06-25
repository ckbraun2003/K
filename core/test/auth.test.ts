import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import {
  isAuthExempt,
  resolveHarnessToken,
  generateToken,
  isLoopbackHost,
  isWeakToken,
  isWeakTerminalToken,
  unsafeBootReason,
  unsafeTerminalBootReason,
  tokensEqual,
  wsTokenOk,
  LEGACY_WEAK_TOKEN,
  LEGACY_WEAK_TERMINAL_TOKEN,
} from '../src/auth.js'

describe('isAuthExempt', () => {
  it('/ws → true', () => expect(isAuthExempt('/ws')).toBe(true))
  it('/ws?token=x → true', () => expect(isAuthExempt('/ws?token=x')).toBe(true))
  it('/health → true', () => expect(isAuthExempt('/health')).toBe(true))
  it('/health?x=1 → true (behavioral fix: previously 401)', () => expect(isAuthExempt('/health?x=1')).toBe(true))
  it('/ws/ → false (exact pathname only)', () => expect(isAuthExempt('/ws/')).toBe(false))
  it('/wsx → false', () => expect(isAuthExempt('/wsx')).toBe(false))
  it('/ws/../api/runs → false (URL normalizes dot-segments)', () => expect(isAuthExempt('/ws/../api/runs')).toBe(false))
  it('/api/runs → false', () => expect(isAuthExempt('/api/runs')).toBe(false))
  it('empty string → false', () => expect(isAuthExempt('')).toBe(false))
  // security invariant: the predicate must NOT percent-decode — the router does,
  // so decoding here would open an exempt path to encoded protected routes
  it('/%77s (encoded /ws) → false', () => expect(isAuthExempt('/%77s')).toBe(false))
  it('//ws (network-path form) → false', () => expect(isAuthExempt('//ws')).toBe(false))
})

describe('generateToken', () => {
  it('is URL-safe base64url, no padding/+//', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('has strong entropy (32 random bytes → 43 chars)', () => {
    expect(generateToken().length).toBeGreaterThanOrEqual(43)
  })
  it('is unique per call', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('resolveHarnessToken', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-auth-'))
    file = path.join(dir, 'auth-token')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('(a) prefers a non-empty HARNESS_TOKEN env', () => {
    const r = resolveHarnessToken({ env: 'env-secret', file })
    expect(r.token).toBe('env-secret')
    expect(r.source).toBe('env')
    expect(r.firstRun).toBe(false)
    // env override must not write a file
    expect(fs.existsSync(file)).toBe(false)
  })

  it('(a) ignores an empty / whitespace env and falls through', () => {
    const r = resolveHarnessToken({ env: '   ', file })
    expect(r.source).toBe('generated')
  })

  it('(b) empty / whitespace persisted file falls through to generation', () => {
    fs.writeFileSync(file, '   \n')
    const r = resolveHarnessToken({ env: '', file })
    expect(r.source).toBe('generated')
    expect(r.firstRun).toBe(true)
    // generation overwrites the empty file with the fresh token
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(r.token)
  })

  it('unwritable data dir → generated token, firstRun, no file created', () => {
    // Point at a path whose parent is a FILE, so mkdir + write both fail.
    const blocker = path.join(dir, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const unwritable = path.join(blocker, 'auth-token')
    const r = resolveHarnessToken({ env: '', file: unwritable })
    expect(r.source).toBe('generated')
    expect(r.firstRun).toBe(true)
    expect(r.token.length).toBeGreaterThanOrEqual(43)
    expect(fs.existsSync(unwritable)).toBe(false)
  })

  it('(c) generates + persists on first run', () => {
    const r = resolveHarnessToken({ env: '', file })
    expect(r.source).toBe('generated')
    expect(r.firstRun).toBe(true)
    expect(r.token.length).toBeGreaterThanOrEqual(43)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(r.token)
  })

  it('(b) reads the persisted token on a second boot (no regenerate)', () => {
    const first = resolveHarnessToken({ env: '', file })
    const second = resolveHarnessToken({ env: '', file })
    expect(second.source).toBe('file')
    expect(second.firstRun).toBe(false)
    expect(second.token).toBe(first.token)
  })

  it('env override wins even when a file exists', () => {
    resolveHarnessToken({ env: '', file }) // create file
    const r = resolveHarnessToken({ env: 'override', file })
    expect(r.token).toBe('override')
    expect(r.source).toBe('env')
  })
})

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost', 'LOCALHOST', '0:0:0:0:0:0:0:1'])(
    '%s → true',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  )
  it.each(['0.0.0.0', '192.168.1.5', '10.0.0.1', 'example.com'])(
    '%s → false',
    (h) => expect(isLoopbackHost(h)).toBe(false),
  )
})

describe('isWeakToken', () => {
  it('empty → weak', () => expect(isWeakToken('')).toBe(true))
  it('whitespace → weak', () => expect(isWeakToken('   ')).toBe(true))
  it('legacy literal → weak', () => expect(isWeakToken(LEGACY_WEAK_TOKEN)).toBe(true))
  it('strong token → not weak', () => expect(isWeakToken(generateToken())).toBe(false))
})

describe('isWeakTerminalToken', () => {
  it('empty → weak', () => expect(isWeakTerminalToken('')).toBe(true))
  it('whitespace → weak', () => expect(isWeakTerminalToken('   ')).toBe(true))
  it('legacy literal → weak', () =>
    expect(isWeakTerminalToken(LEGACY_WEAK_TERMINAL_TOKEN)).toBe(true))
  it('strong token → not weak', () => expect(isWeakTerminalToken(generateToken())).toBe(false))
})

describe('unsafeTerminalBootReason (terminal safety gate)', () => {
  it('disabled → safe (null) regardless of host/token', () => {
    expect(unsafeTerminalBootReason('0.0.0.0', false, LEGACY_WEAK_TERMINAL_TOKEN)).toBeNull()
    expect(unsafeTerminalBootReason('0.0.0.0', false, '')).toBeNull()
  })
  it('enabled + loopback + weak token → safe (null)', () => {
    expect(unsafeTerminalBootReason('127.0.0.1', true, LEGACY_WEAK_TERMINAL_TOKEN)).toBeNull()
    expect(unsafeTerminalBootReason('localhost', true, '')).toBeNull()
  })
  it('enabled + non-loopback + weak token → refuses (message)', () => {
    const reason = unsafeTerminalBootReason('0.0.0.0', true, LEGACY_WEAK_TERMINAL_TOKEN)
    expect(reason).toBeTruthy()
    expect(reason).toContain('TERMINAL_TOKEN')
  })
  it('enabled + non-loopback + empty token → refuses', () => {
    expect(unsafeTerminalBootReason('192.168.1.5', true, '')).toBeTruthy()
  })
  it('enabled + non-loopback + strong token → safe (null)', () => {
    expect(unsafeTerminalBootReason('0.0.0.0', true, generateToken())).toBeNull()
  })
})

describe('unsafeBootReason (safety gate)', () => {
  it('loopback + weak token → safe (null)', () => {
    expect(unsafeBootReason('127.0.0.1', LEGACY_WEAK_TOKEN)).toBeNull()
    expect(unsafeBootReason('localhost', '')).toBeNull()
  })
  it('non-loopback + weak token → refuses (message)', () => {
    const reason = unsafeBootReason('0.0.0.0', LEGACY_WEAK_TOKEN)
    expect(reason).toBeTruthy()
    expect(reason).toContain('HARNESS_TOKEN')
  })
  it('non-loopback + empty token → refuses', () => {
    expect(unsafeBootReason('192.168.1.5', '')).toBeTruthy()
  })
  it('non-loopback + strong token → safe (null)', () => {
    expect(unsafeBootReason('0.0.0.0', generateToken())).toBeNull()
  })
})

describe('tokensEqual (constant-time compare)', () => {
  it('equal strings → true', () => expect(tokensEqual('abc123', 'abc123')).toBe(true))
  it('different content, same length → false', () => expect(tokensEqual('abc123', 'abc124')).toBe(false))
  it('different length → false (no throw)', () => expect(tokensEqual('abc', 'abcdef')).toBe(false))
  it('empty vs empty → true', () => expect(tokensEqual('', '')).toBe(true))
  it("'' vs 'x' → false (no throw on length mismatch)", () =>
    expect(tokensEqual('', 'x')).toBe(false))
})

describe('wsTokenOk (/ws query-param auth)', () => {
  const secret = 'super-secret-token'
  it('correct token → true', () => expect(wsTokenOk(secret, secret)).toBe(true))
  it('wrong token → false', () => expect(wsTokenOk('nope', secret)).toBe(false))
  it('missing token (undefined) → false', () => expect(wsTokenOk(undefined, secret)).toBe(false))
  it('empty token → false', () => expect(wsTokenOk('', secret)).toBe(false))
})

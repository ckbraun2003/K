import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  pickFreePort,
  buildCoreEnv,
  coreEntryPath,
  webDistPath,
  authTokenPath,
  readToken,
  buildDesktopConfig,
  isAllowedNavigation,
  sanitizeExternalTarget,
} from '../src/core-launcher'

describe('pickFreePort', () => {
  it('returns a valid, usable loopback port', async () => {
    const port = await pickFreePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})

describe('buildCoreEnv', () => {
  const env = buildCoreEnv({
    port: 4321,
    dataDir: '/data/k',
    webDist: '/app/web/dist',
    baseEnv: { PATH: '/usr/bin', HARNESS_TOKEN: 'stale-should-be-cleared', FOO: 'bar' },
  })

  it('pins port/host/data-dir/web-dist for the forked core', () => {
    expect(env.PORT).toBe('4321')
    expect(env.HOST).toBe('127.0.0.1')
    expect(env.K_DATA_DIR).toBe('/data/k')
    expect(env.K_WEB_DIST).toBe('/app/web/dist')
  })

  it('forces the terminal off and clears any inherited HARNESS_TOKEN', () => {
    expect(env.ENABLE_TERMINAL).toBe('false')
    // Empty string → core's resolveHarnessToken treats it as unset and generates one.
    expect(env.HARNESS_TOKEN).toBe('')
  })

  it('pins CORS to the actual origin and suppresses the first-run token print', () => {
    expect(env.CORS_ORIGIN).toBe('http://127.0.0.1:4321')
    expect(env.K_SUPPRESS_TOKEN_PRINT).toBe('1')
  })

  it('carries the base env through (PATH etc. must survive so core can spawn CLIs)', () => {
    expect(env.PATH).toBe('/usr/bin')
    expect(env.FOO).toBe('bar')
  })
})

describe('path helpers', () => {
  it('resolve core entry + web dist + token under the resources root', () => {
    expect(coreEntryPath('/app')).toBe(path.join('/app', 'core', 'dist', 'index.js'))
    expect(webDistPath('/app')).toBe(path.join('/app', 'web', 'dist'))
    expect(authTokenPath('/data/k')).toBe(path.join('/data/k', 'auth-token'))
  })
})

describe('readToken', () => {
  it('reads + trims a persisted token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-tok-'))
    fs.writeFileSync(authTokenPath(dir), '  abc123\n')
    expect(readToken(dir)).toBe('abc123')
  })
  it('returns empty string when the token file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-tok-'))
    expect(readToken(dir)).toBe('')
  })
})

describe('buildDesktopConfig', () => {
  it('hands the preload the token only (no port — same-origin URL carries it)', () => {
    expect(buildDesktopConfig('tok-123')).toEqual({ token: 'tok-123' })
  })
})

describe('isAllowedNavigation', () => {
  it('allows only the core loopback origin on the active port', () => {
    expect(isAllowedNavigation('http://127.0.0.1:4321/', 4321)).toBe(true)
    expect(isAllowedNavigation('http://localhost:4321/#/settings', 4321)).toBe(true)
  })
  it('denies remote origins, other ports, and non-http schemes', () => {
    expect(isAllowedNavigation('https://evil.example/', 4321)).toBe(false)
    expect(isAllowedNavigation('http://127.0.0.1:9999/', 4321)).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd', 4321)).toBe(false)
    expect(isAllowedNavigation('javascript:alert(1)', 4321)).toBe(false)
    expect(isAllowedNavigation('not a url', 4321)).toBe(false)
  })
})

describe('sanitizeExternalTarget', () => {
  it('allows allowlisted hosts + subdomains, stripping query/fragment (no token exfil)', () => {
    expect(sanitizeExternalTarget('https://github.com/owner/repo/pull/1')).toBe(
      'https://github.com/owner/repo/pull/1',
    )
    // subdomain of an allowed base domain
    expect(sanitizeExternalTarget('https://docs.claude.com/en/docs/claude-code')).toBe(
      'https://docs.claude.com/en/docs/claude-code',
    )
    // a script-crafted URL carrying a token in the query is stripped to origin+path
    expect(sanitizeExternalTarget('https://github.com/x?t=SECRETTOKEN#frag')).toBe(
      'https://github.com/x',
    )
    // credentials stripped
    expect(sanitizeExternalTarget('https://user:pass@github.com/x')).toBe('https://github.com/x')
  })

  it('refuses non-allowlisted hosts and non-http schemes (returns null)', () => {
    expect(sanitizeExternalTarget('https://evil.example/?t=SECRET')).toBeNull()
    expect(sanitizeExternalTarget('https://github.com.evil.example/')).toBeNull()
    expect(sanitizeExternalTarget('file:///etc/passwd')).toBeNull()
    expect(sanitizeExternalTarget('javascript:alert(1)')).toBeNull()
    expect(sanitizeExternalTarget('not a url')).toBeNull()
  })
})

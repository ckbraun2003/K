/**
 * F-084 (ii): the vite `VITE_TERMINAL_TOKEN` define must NEVER bake a real terminal
 * token into any bundle, and must NEVER bake ANY token (not even the dev literal)
 * into a PROD build — it emits the literal `undefined` so the token is injected at
 * runtime, exactly like the harness login. Only a DEV server with no real token gets
 * the dev literal, for zero-friction loopback dev.
 */
import { describe, it, expect } from 'vitest'
import {
  terminalTokenDefine,
  DEV_TERMINAL_TOKEN,
  harnessTokenDefine,
  DEV_HARNESS_TOKEN,
} from '../src/lib/vite-token-defines'

describe('terminalTokenDefine (vite define guard)', () => {
  it('DEV + no token → the dev literal (JSON-stringified) for loopback convenience', () => {
    expect(terminalTokenDefine({ isDev: true, token: undefined })).toBe(JSON.stringify(DEV_TERMINAL_TOKEN))
  })

  it('DEV + the dev token → still the dev literal', () => {
    expect(terminalTokenDefine({ isDev: true, token: DEV_TERMINAL_TOKEN })).toBe(JSON.stringify(DEV_TERMINAL_TOKEN))
  })

  it('DEV + a REAL token → undefined (never bake a real token, even in dev)', () => {
    expect(terminalTokenDefine({ isDev: true, token: 'real-strong-terminal-token' })).toBe('undefined')
  })

  it('PROD build + no token → undefined (no dev literal in a prod bundle)', () => {
    expect(terminalTokenDefine({ isDev: false, token: undefined })).toBe('undefined')
  })

  it('PROD build + the dev token → undefined (dev literal must not ship to prod)', () => {
    expect(terminalTokenDefine({ isDev: false, token: DEV_TERMINAL_TOKEN })).toBe('undefined')
  })

  it('PROD build + a REAL token → undefined (inject at runtime, never baked)', () => {
    expect(terminalTokenDefine({ isDev: false, token: 'real-strong-terminal-token' })).toBe('undefined')
  })
})

describe('harnessTokenDefine (vite define guard)', () => {
  it('DEV + no token → the dev literal (zero-friction loopback dev / WS auto-auth)', () => {
    expect(harnessTokenDefine({ isDev: true, token: undefined })).toBe(JSON.stringify(DEV_HARNESS_TOKEN))
  })

  it('DEV + the dev token → still the dev literal', () => {
    expect(harnessTokenDefine({ isDev: true, token: DEV_HARNESS_TOKEN })).toBe(JSON.stringify(DEV_HARNESS_TOKEN))
  })

  it('DEV + a REAL token → undefined (never bake a real harness token, even in dev)', () => {
    expect(harnessTokenDefine({ isDev: true, token: 'real-strong-harness-token' })).toBe('undefined')
  })

  it('PROD build + no token → undefined (the F-084ii-class hole: no dev literal in prod)', () => {
    expect(harnessTokenDefine({ isDev: false, token: undefined })).toBe('undefined')
  })

  it('PROD build + the dev token → undefined', () => {
    expect(harnessTokenDefine({ isDev: false, token: DEV_HARNESS_TOKEN })).toBe('undefined')
  })

  it('PROD build + a REAL token → undefined (inject at runtime via login, never baked)', () => {
    expect(harnessTokenDefine({ isDev: false, token: 'real-strong-harness-token' })).toBe('undefined')
  })
})

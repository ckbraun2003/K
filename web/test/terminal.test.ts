import { describe, it, expect } from 'vitest'
import {
  terminalWsUrl,
  encodeInput,
  encodeResize,
  parseServerFrame,
  errorReason,
  errorShort,
} from '../src/lib/terminal'

describe('terminalWsUrl', () => {
  it('appends /ws/terminal + an encoded token to the ws base', () => {
    expect(terminalWsUrl('ws://localhost:3001', 'dev-token-change-me')).toBe(
      'ws://localhost:3001/ws/terminal?token=dev-token-change-me',
    )
  })

  it('url-encodes tokens with special characters', () => {
    expect(terminalWsUrl('ws://host:3001', 'a b/c?d')).toBe(
      'ws://host:3001/ws/terminal?token=a%20b%2Fc%3Fd',
    )
  })

  it('honors whatever base the caller computed (same-origin prod / wss / non-default port)', () => {
    // prod same-origin: base is the page host:port (no dead literal 3001)
    expect(terminalWsUrl('ws://localhost:7790', 't')).toBe(
      'ws://localhost:7790/ws/terminal?token=t',
    )
    // https page → wss base carries through
    expect(terminalWsUrl('wss://k.example', 't')).toBe(
      'wss://k.example/ws/terminal?token=t',
    )
  })
})

describe('encodeInput / encodeResize', () => {
  it('encodes an input frame', () => {
    expect(encodeInput('ls\r')).toBe(JSON.stringify({ type: 'input', data: 'ls\r' }))
  })

  it('encodes a resize frame', () => {
    expect(encodeResize(120, 40)).toBe(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  })
})

describe('parseServerFrame', () => {
  it('parses an output frame', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'output', data: 'hi' }))).toEqual({
      type: 'output',
      data: 'hi',
    })
  })

  it('parses an exit frame', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'exit', exitCode: 0 }))).toEqual({
      type: 'exit',
      exitCode: 0,
    })
  })

  it('parses an error frame', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'error', code: 'disabled' }))).toEqual({
      type: 'error',
      code: 'disabled',
    })
  })

  it('returns null for malformed or unknown frames', () => {
    expect(parseServerFrame('not json')).toBeNull()
    expect(parseServerFrame('null')).toBeNull()
    expect(parseServerFrame(JSON.stringify({ type: 'output' }))).toBeNull()
    expect(parseServerFrame(JSON.stringify({ type: 'exit', exitCode: 'x' }))).toBeNull()
    expect(parseServerFrame(JSON.stringify({ type: 'bogus' }))).toBeNull()
  })
})

describe('errorReason', () => {
  it('maps known codes to user-facing text', () => {
    expect(errorReason('disabled')).toContain('turned off')
    expect(errorReason('unauthorized')).toContain('token')
    expect(errorReason('unavailable')).toContain('unavailable')
  })

  it('the disabled copy has no operator env-var jargon (F-008)', () => {
    expect(errorReason('disabled')).not.toContain('ENABLE_TERMINAL')
    expect(errorReason('disabled')).not.toMatch(/=true/)
  })

  it('falls back to the raw code', () => {
    expect(errorReason('weird')).toContain('weird')
  })
})

describe('errorShort', () => {
  it('gives a short pill label per code (not the full sentence)', () => {
    expect(errorShort('disabled')).toBe('Off')
    expect(errorShort('unauthorized')).toBe('Unauthorized')
    expect(errorShort('unavailable')).toBe('Unavailable')
  })

  it('a null (transport) code reads as Offline', () => {
    expect(errorShort(null)).toBe('Offline')
    expect(errorShort('weird')).toBe('Offline')
  })
})

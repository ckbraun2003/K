import { describe, it, expect } from 'vitest'
import {
  terminalWsUrl,
  encodeInput,
  encodeResize,
  parseServerFrame,
  errorReason,
} from '../src/lib/terminal'

describe('terminalWsUrl', () => {
  it('targets core /ws/terminal with an encoded token', () => {
    expect(terminalWsUrl('localhost', 'dev-token-change-me')).toBe(
      'ws://localhost:3001/ws/terminal?token=dev-token-change-me',
    )
  })

  it('url-encodes tokens with special characters', () => {
    expect(terminalWsUrl('host', 'a b/c?d')).toBe(
      'ws://host:3001/ws/terminal?token=a%20b%2Fc%3Fd',
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
  it('maps known codes to friendly text', () => {
    expect(errorReason('disabled')).toContain('ENABLE_TERMINAL')
    expect(errorReason('unauthorized')).toContain('token')
    expect(errorReason('unavailable')).toContain('pty')
  })

  it('falls back to the raw code', () => {
    expect(errorReason('weird')).toContain('weird')
  })
})

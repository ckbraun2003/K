import { describe, it, expect } from 'vitest'
import { formatBytes, pullStateFromEvent } from '../src/lib/ollama'

describe('formatBytes', () => {
  it('renders GB with one decimal for >= 1 GiB', () => {
    expect(formatBytes(4.1 * 1024 ** 3)).toBe('4.1 GB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
  })
  it('renders MB (no decimal) below 1 GiB', () => {
    expect(formatBytes(400 * 1024 ** 2)).toBe('400 MB')
  })
  it('renders KB below 1 MiB', () => {
    expect(formatBytes(2 * 1024)).toBe('2 KB')
  })
  it('renders raw bytes below 1 KiB', () => {
    expect(formatBytes(512)).toBe('512 B')
  })
  it('degrades unknown / invalid sizes to a dash (never NaN)', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
  })
})

describe('pullStateFromEvent — pins the ollama_pull WS shape', () => {
  it('maps a mid-download progress event', () => {
    const s = pullStateFromEvent({
      type: 'ollama_pull',
      name: 'mistral:7b',
      status: 'downloading',
      completed: 50,
      total: 100,
      percent: 50,
      done: false,
    })
    expect(s).toEqual({ status: 'downloading', completed: 50, total: 100, percent: 50, done: false, error: undefined })
  })
  it('maps a terminal done event (no percent)', () => {
    const s = pullStateFromEvent({ type: 'ollama_pull', name: 'x', status: 'done', done: true })
    expect(s.done).toBe(true)
    expect(s.status).toBe('done')
    expect(s.percent).toBeUndefined()
  })
  it('carries an error on a failed pull', () => {
    const s = pullStateFromEvent({ type: 'ollama_pull', name: 'x', status: 'error', done: true, error: 'nope' })
    expect(s.error).toBe('nope')
    expect(s.done).toBe(true)
  })
})

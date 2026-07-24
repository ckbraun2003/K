import { describe, it, expect } from 'vitest'
import { normalizeBootHash } from '../src/lib/boot-hash'

// UI Adjustments Task C1 — a reload on a deep-linked thread must not resume it.
describe('normalizeBootHash', () => {
  it('strips a deep-linked thread id from #/messages/<id> down to the bare list', () => {
    expect(normalizeBootHash('#/messages/kt-1')).toBe('#/messages')
  })

  it('leaves the bare #/messages hash unchanged', () => {
    expect(normalizeBootHash('#/messages')).toBe('#/messages')
  })

  it('leaves unrelated hashes (e.g. #/home) unchanged', () => {
    expect(normalizeBootHash('#/home')).toBe('#/home')
  })
})

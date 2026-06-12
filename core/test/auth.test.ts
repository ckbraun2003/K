import { describe, it, expect } from 'vitest'
import { isAuthExempt } from '../src/auth.js'

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
})

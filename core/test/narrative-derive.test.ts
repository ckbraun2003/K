/** P3 A1 - deterministic narrative derivation (no model, no I/O). */
import { describe, it, expect } from 'vitest'
import { deriveNarrative, cleanGoal, parseBullets } from '../src/narrative.js'

const RUN_ID = '11111111-2222-4333-8444-555555555555'

describe('deriveNarrative', () => {
  it('computes goal/outcome/files/verification/cost; bullets absent by default', () => {
    const n = deriveNarrative({
      runId: RUN_ID, prompt: 'Create hello.js that prints hello\n\nsome scaffold noise',
      status: 'done', createdAt: 1000, endedAt: 1600, costUsd: 0.0031, tokensIn: 1200, tokensOut: 340,
      verify: { status: 'pass', reason: null, commandCount: 2 }, files: ['hello.js', 'README.md'],
    })
    expect(n.goal).toContain('Create hello.js')
    expect(n.outcome).toEqual({ status: 'done', endedAt: 1600, durationMs: 600 })
    expect(n.files).toEqual(['hello.js', 'README.md'])
    expect(n.verification).toEqual({ status: 'pass', reason: null, commandCount: 2 })
    expect(n.cost).toEqual({ costUsd: 0.0031, tokensIn: 1200, tokensOut: 340 })
    expect(n.bullets).toBeNull()
    expect(n.bulletsState).toBe('unavailable')
  })
  it('honest nulls for a still-running, unverified run', () => {
    const n = deriveNarrative({
      runId: RUN_ID, prompt: 'x', status: 'running', createdAt: 1000, endedAt: null,
      costUsd: 0, tokensIn: 0, tokensOut: 0, verify: null, files: [],
    })
    expect(n.outcome).toEqual({ status: 'running', endedAt: null, durationMs: null })
    expect(n.verification).toBeNull()
  })
  it('cleanGoal strips blank lines and caps length', () => {
    expect(cleanGoal('\n\n  Do the thing  \nmore')).toBe('Do the thing')
    expect(cleanGoal('x'.repeat(500)).length).toBeLessThanOrEqual(280)
  })
})

describe('parseBullets', () => {
  it('parses strict json, clamps to 3, stamps generated:true + model', () => {
    const b = parseBullets('{"decisions":["a","b","c","d"],"risks":["r1"]}', 'qwen2.5')!
    expect(b.decisions).toEqual(['a', 'b', 'c'])
    expect(b.risks).toEqual(['r1'])
    expect(b.generated).toBe(true)
    expect(b.model).toBe('qwen2.5')
  })
  it('tolerates a fenced/preambled blob by extracting the first object', () => {
    const b = parseBullets('Sure!\n```json\n{"decisions":["x"],"risks":[]}\n```', 'm')!
    expect(b.decisions).toEqual(['x'])
  })
  it('returns null on garbage / empty / non-array fields', () => {
    expect(parseBullets('not json at all', 'm')).toBeNull()
    expect(parseBullets('', 'm')).toBeNull()
    expect(parseBullets('{"decisions":"nope","risks":[]}', 'm')).toBeNull()
  })
})

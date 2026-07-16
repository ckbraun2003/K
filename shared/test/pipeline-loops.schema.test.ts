import { describe, expect, test } from 'vitest'
import { PipelineSpecSchema } from '../src/types'

// Task 0.1 (orch-p2 W0) — loop-edge + sub-agent + ledger Zod contracts.
// PURELY ADDITIVE: `when:'loop'` is a new bounded back-edge; the Phase-1
// `when:'repair'` deferral fence stays exactly as-is (see case (g) below).

const stage = (id: string) =>
  ({ kind: 'agent' as const, id, label: id.toUpperCase(), role: 'worker', promptScaffold: `do ${id}` })

const gateStage = (id: string) => ({ kind: 'gate' as const, id, label: id.toUpperCase(), gate: {} })

function issuePaths(result: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) {
  if (result.success) return []
  return result.error!.issues.map(i => i.path.join('.'))
}

describe('pipeline loop edges', () => {
  // (a) valid bounded loop parses: a→b→c, c→b when:'loop' maxIterations:3, c→done when:'pass'
  test('valid bounded loop parses', () => {
    const spec = {
      name: 'loop-ok', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop', maxIterations: 3 },
        { from: 'c', to: 'done', when: 'pass' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(true)
  })

  // (b) when:'loop' without maxIterations is rejected
  test('loop edge without maxIterations is rejected', () => {
    const spec = {
      name: 'loop-no-max', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop' },
        { from: 'c', to: 'done', when: 'pass' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('edges.2.maxIterations')
  })

  // (c) maxIterations out of range (0, 11) is rejected
  test('maxIterations:0 is rejected', () => {
    const spec = {
      name: 'loop-max-0', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop', maxIterations: 0 },
        { from: 'c', to: 'done', when: 'pass' },
      ],
    }
    expect(PipelineSpecSchema.safeParse(spec).success).toBe(false)
  })

  test('maxIterations:11 is rejected', () => {
    const spec = {
      name: 'loop-max-11', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop', maxIterations: 11 },
        { from: 'c', to: 'done', when: 'pass' },
      ],
    }
    expect(PipelineSpecSchema.safeParse(spec).success).toBe(false)
  })

  // (d) loop target not an ancestor of the loop head is rejected
  test('loop target not an ancestor is rejected', () => {
    const spec = {
      name: 'loop-bad-target', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c'), stage('x')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'x' },
        { from: 'c', to: 'x', when: 'loop', maxIterations: 2 },
        { from: 'c', to: 'done', when: 'pass' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('edges.3.to')
  })

  // (e) loop head with no forward exit is rejected
  test('loop head with no forward exit is rejected', () => {
    const spec = {
      name: 'loop-no-exit', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop', maxIterations: 2 },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('edges.2')
  })

  // (f) a forward-only cycle (no when:'loop' edge) is rejected
  test('forward-only cycle without a loop edge is rejected', () => {
    const spec = {
      name: 'loop-forward-cycle', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('edges')
  })

  // (g) regression: the Phase-1 when:'repair' deferral fence is untouched by this change
  test('when:repair edges are still rejected (Phase-1 fence unchanged)', () => {
    const spec = {
      name: 'still-fenced', entry: 'a',
      stages: [stage('a'), stage('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a', when: 'repair' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('edges.1.when')
  })

  // (h) bonus: a forward exit into a gate stage (not just pass/always) satisfies the rule
  test('a forward exit into a gate stage satisfies the loop-head exit rule', () => {
    const spec = {
      name: 'loop-gate-exit', entry: 'a',
      stages: [stage('a'), stage('b'), stage('c'), gateStage('g')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b', when: 'loop', maxIterations: 2 },
        { from: 'c', to: 'g', when: 'fail' },
      ],
    }
    const result = PipelineSpecSchema.safeParse(spec)
    expect(result.success).toBe(true)
  })
})

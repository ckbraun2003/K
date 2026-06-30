/**
 * Unit tests for the aggregation/metrics module (core/src/eval/metrics.ts), ported behavior-for-
 * behavior from testing/eval/harness/metrics.mjs:
 *   - aggregate() over synthetic real+degraded, multi-model records → per-system means,
 *     discriminationJudge / discriminationDet / discriminationPass, perModel, and overall;
 *   - compareToBaselines() against a temp baselines dir → no-baseline vs ok vs REGRESSION;
 *   - writeBaselines() → compareToBaselines() round-trip (freeze then compare = ok) in a temp dir.
 *
 * Pure functions + a throwaway temp dir; no dispatch, no DB.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregate, compareToBaselines, writeBaselines, baselineDir } from '../src/eval/metrics.js'
import type { EvalRecord } from '../src/eval/types.js'

function rec(p: Partial<EvalRecord> & Pick<EvalRecord, 'system' | 'model' | 'variant'>): EvalRecord {
  return p
}

// sysA: two models (opus, sonnet) × two variants (real, degraded).
const records: EvalRecord[] = [
  rec({ system: 'sysA', model: 'opus', variant: 'real',
    det: { detPass: true, detScore: 1.0, formatScore: 1.0 }, judge: { overall: 0.9 },
    metricsRaw: { costUsd: 0.5, ms: 1000, numTurns: 3, refusalCorrect: true, tokensIn: 100, tokensOut: 50 } }),
  rec({ system: 'sysA', model: 'sonnet', variant: 'real',
    det: { detPass: true, detScore: 0.8, formatScore: 0.5 }, judge: { overall: 0.7 },
    metricsRaw: { costUsd: 0.3, ms: 2000, numTurns: 5, refusalCorrect: false, tokensIn: 200, tokensOut: 80 } }),
  rec({ system: 'sysA', model: 'opus', variant: 'degraded',
    det: { detPass: false, detScore: 0.2 }, judge: { overall: 0.3 },
    metricsRaw: { costUsd: 0.4, ms: 1500, numTurns: 4 } }),
  rec({ system: 'sysA', model: 'sonnet', variant: 'degraded',
    det: { detPass: false, detScore: 0.1 }, judge: { overall: 0.2 },
    metricsRaw: { costUsd: 0.2, ms: 2500, numTurns: 6 } }),
]

describe('aggregate() — per-system metrics + discrimination control', () => {
  const { perSystem, overall } = aggregate(records)
  const s = perSystem.sysA

  it('real-variant means', () => {
    expect(s.real.judgeMean).toBeCloseTo(0.8, 3)         // (0.9+0.7)/2
    expect(s.real.detScoreMean).toBeCloseTo(0.9, 3)      // (1.0+0.8)/2
    expect(s.real.detPassRate).toBe(1)                   // both pass
    expect(s.real.formatMean).toBeCloseTo(0.75, 3)       // (1.0+0.5)/2
    expect(s.real.refusalCorrectRate).toBeCloseTo(0.5, 3) // 1 of 2 correct
    expect(s.real.costUsd).toBeCloseTo(0.8, 3)           // 0.5+0.3
    expect(s.real.latencyMsMean).toBe(1500)              // (1000+2000)/2
    expect(s.real.turnsMean).toBe(4)                     // (3+5)/2
    expect(s.real.tokensInSum).toBe(300)
    expect(s.real.tokensOutSum).toBe(130)
  })

  it('degraded-variant means', () => {
    expect(s.degraded.judgeMean).toBeCloseTo(0.25, 3)    // (0.3+0.2)/2
    expect(s.degraded.detScoreMean).toBeCloseTo(0.15, 3) // (0.2+0.1)/2
    expect(s.degraded.detPassRate).toBe(0)
  })

  it('discrimination (real − degraded) on judge + det, and the pass gate', () => {
    expect(s.discriminationJudge).toBeCloseTo(0.55, 3)   // 0.8 − 0.25
    expect(s.discriminationDet).toBeCloseTo(0.75, 3)     // 0.9 − 0.15
    // discriminationPass gates on the deterministic delta (≥ 0.1 default) → true
    expect(s.discriminationPass).toBe(true)
  })

  it('per-model breakdown', () => {
    expect(s.perModel.opus.real.judgeMean).toBeCloseTo(0.9, 3)
    expect(s.perModel.opus.degraded.judgeMean).toBeCloseTo(0.3, 3)
    expect(s.perModel.opus.discriminationJudge).toBeCloseTo(0.6, 3)
    expect(s.perModel.sonnet.discriminationJudge).toBeCloseTo(0.5, 3)
  })

  it('overall rollup', () => {
    expect(overall.systems).toBe(1)
    expect(overall.models).toEqual(['opus', 'sonnet'])
    expect(overall.totalRecords).toBe(4)
    expect(overall.totalCostUsd).toBeCloseTo(1.4, 3)     // 0.5+0.3+0.4+0.2
    expect(overall.realJudgeMean).toBeCloseTo(0.8, 3)
    expect(overall.realDetPassRate).toBe(1)
    expect(overall.discriminationPassCount).toBe(1)
  })

  it('discriminationPass is null when there is no degraded variant to compare', () => {
    const realOnly = aggregate(records.filter(r => r.variant === 'real'))
    expect(realOnly.perSystem.sysA.discriminationDet).toBeNull()
    expect(realOnly.perSystem.sysA.discriminationPass).toBeNull()
  })

  it('a below-threshold judge delta with no det delta does NOT pass', () => {
    // Only judge present (no detScore) so discDet is null and it falls back to the judge gate (0.15).
    const tiny: EvalRecord[] = [
      rec({ system: 'sX', model: 'opus', variant: 'real', judge: { overall: 0.5 } }),
      rec({ system: 'sX', model: 'opus', variant: 'degraded', judge: { overall: 0.45 } }),
    ]
    const r = aggregate(tiny)
    expect(r.perSystem.sX.discriminationDet).toBeNull()
    expect(r.perSystem.sX.discriminationJudge).toBeCloseTo(0.05, 3)
    expect(r.perSystem.sX.discriminationPass).toBe(false) // 0.05 < 0.15
  })
})

describe('compareToBaselines() + writeBaselines() against a temp dir', () => {
  const tmpRoots: string[] = []
  function freshRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'k-eval-metrics-'))
    tmpRoots.push(root)
    return root
  }
  afterAll(() => { for (const r of tmpRoots) { try { rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } } })

  const { perSystem } = aggregate(records)

  it('no baseline file → status no-baseline', () => {
    const root = freshRoot()
    const cmp = compareToBaselines({ perSystem, root })
    expect(cmp.sysA.status).toBe('no-baseline')
  })

  it('a close baseline → ok with small deltas', () => {
    const root = freshRoot()
    const dir = baselineDir(root)
    mkdirSync(dir, { recursive: true })
    // current real.judgeMean = 0.8; baseline 0.82 → delta −0.02 (within −0.1 threshold)
    writeFileSync(path.join(dir, 'sysA.json'), JSON.stringify({
      real: { judgeMean: 0.82, detPassRate: 1, detScoreMean: 0.9 }, discriminationJudge: 0.55,
    }))
    const cmp = compareToBaselines({ perSystem, root })
    expect(cmp.sysA.status).toBe('ok')
    expect(cmp.sysA.deltas?.judgeMean).toBeCloseTo(-0.02, 3)
  })

  it('a much higher baseline → REGRESSION', () => {
    const root = freshRoot()
    const dir = baselineDir(root)
    mkdirSync(dir, { recursive: true })
    // baseline judgeMean 0.95 vs now 0.8 → delta −0.15 < −0.1 → regression
    writeFileSync(path.join(dir, 'sysA.json'), JSON.stringify({
      real: { judgeMean: 0.95, detPassRate: 1, detScoreMean: 0.9 },
    }))
    const cmp = compareToBaselines({ perSystem, root })
    expect(cmp.sysA.status).toBe('REGRESSION')
    expect(cmp.sysA.deltas?.judgeMean).toBeCloseTo(-0.15, 3)
  })

  it('a dropped discrimination delta ALONE → REGRESSION (the discriminationJudge branch)', () => {
    const root = freshRoot()
    const dir = baselineDir(root)
    mkdirSync(dir, { recursive: true })
    // real.* metrics MATCH the baseline (deltas 0, within threshold) so the only thing that can
    // regress is the discrimination delta: baseline discriminationJudge 0.70 vs now 0.55 → −0.15
    // < −0.1 → REGRESSION via that branch specifically (isolates it from the real.* checks).
    writeFileSync(path.join(dir, 'sysA.json'), JSON.stringify({
      real: { judgeMean: 0.8, detPassRate: 1, detScoreMean: 0.9 }, discriminationJudge: 0.70,
    }))
    const cmp = compareToBaselines({ perSystem, root })
    expect(cmp.sysA.status).toBe('REGRESSION')
    expect(cmp.sysA.deltas?.judgeMean).toBe(0)
    expect(cmp.sysA.deltas?.discriminationJudge).toBeCloseTo(-0.15, 3)
  })

  it('writeBaselines → compareToBaselines round-trip is ok (zero deltas)', () => {
    const root = freshRoot()
    const written = writeBaselines({ perSystem, root })
    expect(written).toEqual(['sysA'])
    const cmp = compareToBaselines({ perSystem, root })
    expect(cmp.sysA.status).toBe('ok')
    expect(cmp.sysA.deltas?.judgeMean).toBe(0)
    expect(cmp.sysA.deltas?.detScoreMean).toBe(0)
  })
})

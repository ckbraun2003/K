import { describe, it, expect } from 'vitest'
import {
  formatPct,
  formatScore,
  formatCost,
  runProgress,
  discriminationStatus,
  regressionBadge,
  runStatusColor,
  detPassGlyph,
  resultTally,
  EMPTY,
  type BaselineCompare,
} from '../src/lib/evals'

describe('formatPct', () => {
  it('rounds a fraction to an integer percent', () => {
    expect(formatPct(0.934)).toBe('93%')
    expect(formatPct(0.935)).toBe('94%') // rounds half up
    expect(formatPct(0)).toBe('0%')
    expect(formatPct(1)).toBe('100%')
  })
  it('returns the em-dash for absent/non-finite input', () => {
    expect(formatPct(null)).toBe(EMPTY)
    expect(formatPct(undefined)).toBe(EMPTY)
    expect(formatPct(NaN)).toBe(EMPTY)
    expect(formatPct(Infinity)).toBe(EMPTY)
    expect(formatPct(-Infinity)).toBe(EMPTY)
  })
})

describe('formatScore', () => {
  it('renders a fixed-digit score (default 2)', () => {
    expect(formatScore(0.875)).toBe('0.88')
    expect(formatScore(0.1)).toBe('0.10')
    expect(formatScore(1)).toBe('1.00')
    expect(formatScore(0)).toBe('0.00')
  })
  it('honours a custom digit count', () => {
    expect(formatScore(0.875, 1)).toBe('0.9')
    expect(formatScore(0.875, 3)).toBe('0.875')
  })
  it('returns the em-dash for absent/non-finite input', () => {
    expect(formatScore(null)).toBe(EMPTY)
    expect(formatScore(undefined)).toBe(EMPTY)
    expect(formatScore(NaN)).toBe(EMPTY)
    expect(formatScore(Infinity)).toBe(EMPTY)
  })
})

describe('formatCost', () => {
  it('shows 4 decimals below $1 and 2 at/above $1', () => {
    expect(formatCost(0.0123)).toBe('$0.0123')
    expect(formatCost(0)).toBe('$0.0000')
    expect(formatCost(1)).toBe('$1.00')
    expect(formatCost(12.5)).toBe('$12.50')
  })
  it('returns the em-dash for absent/non-finite input', () => {
    expect(formatCost(null)).toBe(EMPTY)
    expect(formatCost(undefined)).toBe(EMPTY)
    expect(formatCost(NaN)).toBe(EMPTY)
    expect(formatCost(Infinity)).toBe(EMPTY)
  })
})

describe('runProgress', () => {
  it('reports 0 pct and a "0/0" label when there is no work', () => {
    expect(runProgress({ completedJobs: 0, totalJobs: 0 })).toEqual({
      done: 0,
      total: 0,
      pct: 0,
      label: '0/0',
    })
  })
  it('computes the fraction and label for a partial run', () => {
    const p = runProgress({ completedJobs: 3, totalJobs: 8 })
    expect(p.done).toBe(3)
    expect(p.total).toBe(8)
    expect(p.pct).toBeCloseTo(0.375)
    expect(p.label).toBe('3/8')
  })
  it('clamps pct to 1 when completed exceeds total', () => {
    const p = runProgress({ completedJobs: 12, totalJobs: 8 })
    expect(p.pct).toBe(1)
    expect(p.label).toBe('12/8')
  })
  it('floors negatives at 0', () => {
    const p = runProgress({ completedJobs: -2, totalJobs: -5 })
    expect(p).toEqual({ done: 0, total: 0, pct: 0, label: '0/0' })
  })
})

describe('discriminationStatus', () => {
  it('maps true → pass (green)', () => {
    expect(discriminationStatus(true)).toEqual({ label: 'pass', colorClass: 'text-[var(--green)]' })
  })
  it('maps false → FAIL (red)', () => {
    expect(discriminationStatus(false)).toEqual({ label: 'FAIL', colorClass: 'text-[var(--red)]' })
  })
  it('maps null → n/a (muted)', () => {
    expect(discriminationStatus(null)).toEqual({ label: 'n/a', colorClass: 'text-[var(--muted)]' })
  })
})

describe('regressionBadge', () => {
  const ok: BaselineCompare = { status: 'ok' }
  const regressed: BaselineCompare = { status: 'REGRESSION', deltas: { detPassRate: -0.2 } }
  const none: BaselineCompare = { status: 'no-baseline' }
  it('maps ok → green', () => {
    expect(regressionBadge(ok)).toEqual({ label: 'ok', colorClass: 'bg-green-500/20 text-green-300' })
  })
  it('maps REGRESSION → red', () => {
    expect(regressionBadge(regressed)).toEqual({
      label: 'REGRESSION',
      colorClass: 'bg-red-500/20 text-red-300',
    })
  })
  it('maps no-baseline → muted', () => {
    expect(regressionBadge(none)).toEqual({
      label: 'no baseline',
      colorClass: 'bg-[var(--raised)] text-[var(--muted)]',
    })
  })
  it('maps undefined → muted', () => {
    expect(regressionBadge(undefined)).toEqual({
      label: 'no baseline',
      colorClass: 'bg-[var(--raised)] text-[var(--muted)]',
    })
  })
  it('maps dry → neutral (never red) — a dry run is not compared to real baselines (F-025)', () => {
    expect(regressionBadge({ status: 'dry' })).toEqual({
      label: 'dry',
      colorClass: 'bg-[var(--raised)] text-[var(--muted)]',
    })
  })
})

describe('resultTally', () => {
  it('counts passed/failed/total, distinguishing passed from completed (F-044)', () => {
    const t = resultTally([
      { detPass: 1, error: null },
      { detPass: 1, error: null },
      { detPass: 0, error: null },
      { detPass: null, error: 'boom' }, // errored → failed
    ])
    expect(t.passed).toBe(2)
    expect(t.failed).toBe(2)
    expect(t.total).toBe(4)
    expect(t.label).toBe('2/4 passed')
    // passed must NOT equal the completed/total count when there are failures
    expect(t.passed).not.toBe(t.total)
  })
  it('treats a null detPass with no error as neither passed nor failed', () => {
    expect(resultTally([{ detPass: null, error: null }])).toEqual({
      passed: 0, failed: 0, total: 1, label: '0/1 passed',
    })
  })
  it('reports all-passed only when every row passed', () => {
    const t = resultTally([{ detPass: 1, error: null }, { detPass: 1, error: null }])
    expect(t).toEqual({ passed: 2, failed: 0, total: 2, label: '2/2 passed' })
  })
})

describe('runStatusColor', () => {
  it('maps each known status', () => {
    expect(runStatusColor('queued')).toBe('bg-amber/15 text-[var(--amber)]')
    expect(runStatusColor('running')).toBe('bg-accent/15 text-[var(--accent-hover)]')
    expect(runStatusColor('done')).toBe('bg-green/15 text-[var(--green)]')
    expect(runStatusColor('error')).toBe('bg-red/15 text-[var(--red)]')
    expect(runStatusColor('killed')).toBe('bg-muted/15 text-[var(--muted)]')
    expect(runStatusColor('interrupted')).toBe('bg-red/15 text-[var(--red)]')
  })
  it('falls back to muted for an unknown status', () => {
    expect(runStatusColor('weird')).toBe('bg-muted/15 text-[var(--muted)]')
    expect(runStatusColor('')).toBe('bg-muted/15 text-[var(--muted)]')
  })
})

describe('detPassGlyph', () => {
  it('maps 1 → ✓, 0 → ✗, null → em-dash', () => {
    expect(detPassGlyph(1)).toBe('✓')
    expect(detPassGlyph(0)).toBe('✗')
    expect(detPassGlyph(null)).toBe(EMPTY)
  })
})

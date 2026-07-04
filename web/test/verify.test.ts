import { describe, it, expect, vi } from 'vitest'
import type { Finding, VerificationReport, WsMessage } from '@k/shared'
import {
  groupFindings,
  barPct,
  scoreColor,
  formatTimeAgo,
  latestReport,
  trendIndicator,
  BREAKDOWN_BARS,
  BREAKDOWN_MAX,
  SEVERITY_ORDER,
} from '../src/lib/verify'

function report(over: Partial<VerificationReport> = {}): VerificationReport {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    projectId: '00000000-0000-0000-0000-0000000000aa',
    score: 80,
    findings: [],
    fixesApplied: [],
    startedAt: 1000,
    ...over,
  }
}

describe('barPct', () => {
  it('returns the value/max proportion for the four weighted maxima', () => {
    expect(barPct(40, BREAKDOWN_MAX.ci)).toBe(1) // CI full = 40/40
    expect(barPct(20, BREAKDOWN_MAX.ci)).toBe(0.5)
    expect(barPct(10, BREAKDOWN_MAX.coverage)).toBe(0.5) // coverage /20
    expect(barPct(20, BREAKDOWN_MAX.bible)).toBe(1)
    expect(barPct(0, BREAKDOWN_MAX.findings)).toBe(0)
  })

  it('clamps to [0,1] for over-max or negative values', () => {
    expect(barPct(99, 40)).toBe(1)
    expect(barPct(-5, 40)).toBe(0)
  })

  it('returns 0 for a non-positive max', () => {
    expect(barPct(5, 0)).toBe(0)
  })

  it('returns 0 for a null (UNMEASURED) value — an empty bar, not a full one', () => {
    expect(barPct(null, 40)).toBe(0)
  })
})

// scoreColor + null (insufficient-signal) handling (F-032 rework)
describe('scoreColor', () => {
  it('maps score bands to green/amber/red', () => {
    expect(scoreColor(90)).toContain('green')
    expect(scoreColor(60)).toContain('amber')
    expect(scoreColor(20)).toContain('red')
  })
  it('renders a null score (insufficient signal) muted', () => {
    expect(scoreColor(null)).toContain('muted')
  })
})

describe('breakdown bar config', () => {
  it('exposes four bars CI/40, Coverage/20, Bible/20, Findings/20', () => {
    expect(BREAKDOWN_BARS.map(b => b.key)).toEqual(['ci', 'coverage', 'bible', 'findings'])
    expect(BREAKDOWN_BARS.map(b => BREAKDOWN_MAX[b.key])).toEqual([40, 20, 20, 20])
  })
})

describe('groupFindings', () => {
  const findings: Finding[] = [
    { severity: 'info', area: 'bible', message: 'doc stale' },
    { severity: 'critical', area: 'ci', message: 'build red' },
    { severity: 'warn', area: 'tests', message: 'coverage dip' },
    { severity: 'critical', area: 'security', message: 'secret leaked' },
  ]

  it('groups in critical → warn → info order', () => {
    const groups = groupFindings(findings)
    expect(groups.map(g => g.severity)).toEqual(['critical', 'warn', 'info'])
  })

  it('keeps input order within a severity bucket', () => {
    const groups = groupFindings(findings)
    const crit = groups.find(g => g.severity === 'critical')!
    expect(crit.items.map(f => f.area)).toEqual(['ci', 'security'])
  })

  it('omits empty severities', () => {
    const groups = groupFindings([{ severity: 'warn', area: 'a', message: 'b' }])
    expect(groups.map(g => g.severity)).toEqual(['warn'])
  })

  it('returns [] for no findings', () => {
    expect(groupFindings([])).toEqual([])
  })

  it('SEVERITY_ORDER is the canonical render order', () => {
    expect(SEVERITY_ORDER).toEqual(['critical', 'warn', 'info'])
  })
})

describe('breakdown absence', () => {
  it('a report may have no breakdown (old report) — callers must guard', () => {
    const r = report()
    expect(r.breakdown).toBeUndefined()
  })

  it('a report with a breakdown exposes all four components', () => {
    const r = report({ breakdown: { ci: 40, coverage: 10, bible: 20, findings: 15 } })
    expect(r.breakdown).toEqual({ ci: 40, coverage: 10, bible: 20, findings: 15 })
  })
})

describe('formatTimeAgo', () => {
  const now = 10_000_000_000
  it('returns "never verified" when absent', () => {
    expect(formatTimeAgo(undefined, now)).toBe('never verified')
  })
  it('renders coarse relative time', () => {
    expect(formatTimeAgo(now - 30_000, now)).toBe('verified just now')
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('verified 5m ago')
    expect(formatTimeAgo(now - 3 * 3_600_000, now)).toBe('verified 3h ago')
    expect(formatTimeAgo(now - 3 * 86_400_000, now)).toBe('verified 3d ago')
  })
})

describe('latestReport', () => {
  it('returns undefined for an empty list', () => {
    expect(latestReport([])).toBeUndefined()
  })
  it('returns the newest by startedAt regardless of input order', () => {
    const a = report({ id: '00000000-0000-0000-0000-00000000000a', startedAt: 100 })
    const b = report({ id: '00000000-0000-0000-0000-00000000000b', startedAt: 300 })
    const c = report({ id: '00000000-0000-0000-0000-00000000000c', startedAt: 200 })
    expect(latestReport([a, b, c])!.id).toBe(b.id)
  })
})

// Mirrors the page's onWsMessage handler: discriminate on type + projectId,
// then invalidate both query keys. Tested without a React renderer because the
// web test infra is pure-unit (no jsdom/testing-library).
describe('verification_update WS handler', () => {
  const projectId = '00000000-0000-0000-0000-0000000000aa'

  function makeHandler(qc: { invalidateQueries: (a: { queryKey: unknown[] }) => void }) {
    return (msg: WsMessage) => {
      if (msg.type === 'verification_update' && msg.report.projectId === projectId) {
        qc.invalidateQueries({ queryKey: ['verifications', projectId] })
        qc.invalidateQueries({ queryKey: ['projects'] })
      }
    }
  }

  it('invalidates both queries for a matching project update', () => {
    const invalidateQueries = vi.fn()
    const handler = makeHandler({ invalidateQueries })
    handler({ type: 'verification_update', report: report({ score: 91 }) })
    expect(invalidateQueries).toHaveBeenCalledTimes(2)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['verifications', projectId] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('ignores updates for a different project', () => {
    const invalidateQueries = vi.fn()
    const handler = makeHandler({ invalidateQueries })
    handler({
      type: 'verification_update',
      report: report({ projectId: '00000000-0000-0000-0000-0000000000bb' }),
    })
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('ignores non-verification messages', () => {
    const invalidateQueries = vi.fn()
    const handler = makeHandler({ invalidateQueries })
    handler({ type: 'ping' })
    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})

describe('trendIndicator (F-052 — shared by the verify tab + standalone page)', () => {
  const a = report({ id: 'a', startedAt: 3000, score: 80 }) // newest
  const b = report({ id: 'b', startedAt: 2000, score: 60 })
  const c = report({ id: 'c', startedAt: 1000, score: 70 }) // oldest
  const reports = [b, a, c] // deliberately unsorted

  it('marks an improvement over the previous report with ▲', () => {
    expect(trendIndicator(reports, 'a')).toBe(' ▲') // 80 > 60
  })
  it('marks a regression with ▼', () => {
    expect(trendIndicator(reports, 'b')).toBe(' ▼') // 60 < 70
  })
  it('marks the oldest report (no prior) with an empty string', () => {
    expect(trendIndicator(reports, 'c')).toBe('')
  })
  it('marks an unchanged score with =', () => {
    const eq = [report({ id: 'x', startedAt: 2, score: 50 }), report({ id: 'y', startedAt: 1, score: 50 })]
    expect(trendIndicator(eq, 'x')).toBe(' =')
  })

  it('shows no trend when either report had a null (insufficient-signal) score', () => {
    const withNull = [report({ id: 'p', startedAt: 2, score: null }), report({ id: 'q', startedAt: 1, score: 80 })]
    expect(trendIndicator(withNull, 'p')).toBe('') // current null → no comparison
    const nullPrev = [report({ id: 'p', startedAt: 2, score: 80 }), report({ id: 'q', startedAt: 1, score: null })]
    expect(trendIndicator(nullPrev, 'p')).toBe('') // prior null → no comparison
  })
})

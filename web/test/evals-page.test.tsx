import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SystemMetricsTable, EvalResultsTable, RunSummaryRow } from '../src/pages/EvalsPage'
import type {
  SystemMetrics,
  BaselineCompare,
  EvalResultRow,
  EvalRunSummary,
} from '../src/lib/evals'

// jsdom has no matchMedia; framer-motion may probe it. Provide an inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => cleanup())

// ── Factories ──────────────────────────────────────────────────────────────

function metrics(over: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    n: { real: 4, degraded: 4 },
    real: {
      judgeMean: 0.82,
      detPassRate: 0.9,
      detScoreMean: 0.88,
      formatMean: 1,
      refusalCorrectRate: 1,
      costUsd: 0.01,
      latencyMsMean: 1200,
      turnsMean: 2,
      tokensInSum: 100,
      tokensOutSum: 200,
    },
    degraded: { judgeMean: 0.3, detPassRate: 0.2, detScoreMean: 0.25 },
    discriminationJudge: 0.52,
    discriminationDet: 0.7,
    discriminationPass: true,
    perModel: {},
    ...over,
  }
}

function result(over: Partial<EvalResultRow> = {}): EvalResultRow {
  return {
    id: 'r1',
    evalRunId: 'run-1',
    systemId: 'planner',
    caseId: 'case-a',
    model: 'sonnet',
    variant: 'real',
    detPass: 1,
    detScore: 0.9,
    formatScore: 1,
    judgeOverall: 0.85,
    judgeVerdict: 'good',
    refusalCorrect: 1,
    costUsd: 0.02,
    ms: 1000,
    numTurns: 3,
    error: null,
    raw: null,
    createdAt: 1000,
    ...over,
  }
}

function summary(over: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    id: 'run-1',
    status: 'done',
    dry: true,
    models: ['sonnet'],
    variants: ['real', 'degraded'],
    systems: ['planner'],
    totalJobs: 8,
    completedJobs: 8,
    totalCostUsd: 0,
    error: null,
    createdAt: Date.now() - 60_000,
    completedAt: Date.now(),
    ...over,
  }
}

// ── SystemMetricsTable ───────────────────────────────────────────────────────

describe('SystemMetricsTable', () => {
  it('renders one row per system with formatted pass-rate and scores', () => {
    const perSystem = { planner: metrics() }
    const regression: Record<string, BaselineCompare> = { planner: { status: 'ok' } }
    render(<SystemMetricsTable perSystem={perSystem} regression={regression} />)
    const row = screen.getByTestId('evals-metric-row-planner')
    expect(row.textContent).toContain('planner')
    expect(row.textContent).toContain('0.82') // real judgeMean (formatScore)
    expect(row.textContent).toContain('90%') // real detPassRate (formatPct)
    expect(row.textContent).toContain('20%') // degraded detPassRate
    expect(row.textContent).toContain('pass') // discriminationStatus(true)
    expect(row.textContent).toContain('ok') // regressionBadge ok
  })

  it('shows the FAIL badge when discriminationPass is false', () => {
    const perSystem = { planner: metrics({ discriminationPass: false }) }
    render(<SystemMetricsTable perSystem={perSystem} regression={{}} />)
    expect(screen.getByTestId('evals-metric-row-planner').textContent).toContain('FAIL')
  })

  it('shows the REGRESSION badge for a regressed compare', () => {
    const perSystem = { planner: metrics() }
    const regression: Record<string, BaselineCompare> = { planner: { status: 'REGRESSION' } }
    render(<SystemMetricsTable perSystem={perSystem} regression={regression} />)
    expect(screen.getByTestId('evals-metric-row-planner').textContent).toContain('REGRESSION')
  })

  it('shows an empty state when there are no systems', () => {
    render(<SystemMetricsTable perSystem={{}} regression={{}} />)
    expect(screen.getByTestId('evals-metrics-empty')).toBeTruthy()
  })
})

// ── EvalResultsTable ───────────────────────────────────────────────────────────

describe('EvalResultsTable', () => {
  it('renders a real result row with its detPass glyph and judge score', () => {
    render(<EvalResultsTable rows={[result()]} />)
    const row = screen.getByTestId('evals-result-row-r1')
    expect(row.textContent).toContain('planner')
    expect(row.textContent).toContain('case-a')
    expect(row.textContent).toContain('real')
    expect(row.textContent).toContain('✓') // detPass=1
    expect(row.textContent).toContain('0.85') // judgeOverall
  })

  it('renders a degraded result row with its variant chip', () => {
    render(<EvalResultsTable rows={[result({ id: 'r2', variant: 'degraded', detPass: 0 })]} />)
    const row = screen.getByTestId('evals-result-row-r2')
    expect(row.textContent).toContain('degraded')
    expect(row.textContent).toContain('✗') // detPass=0
  })

  it('surfaces an error cell when the result errored', () => {
    render(<EvalResultsTable rows={[result({ id: 'r3', error: 'dispatch failed' })]} />)
    expect(screen.getByTestId('evals-result-error-r3').textContent).toContain('dispatch failed')
  })

  it('shows an empty state when there are no rows', () => {
    render(<EvalResultsTable rows={[]} />)
    expect(screen.getByTestId('evals-results-empty')).toBeTruthy()
  })
})

// ── RunSummaryRow ──────────────────────────────────────────────────────────────

describe('RunSummaryRow', () => {
  it('shows a "dry" chip and the progress label for a dry run', () => {
    render(<RunSummaryRow run={summary()} expanded={false} onToggle={() => {}} />)
    const row = screen.getByTestId('evals-run-row-run-1')
    expect(row.textContent).toContain('dry')
    expect(row.textContent).toContain('done')
    expect(row.textContent).toContain('8/8')
  })

  it('shows a "REAL" chip for a token-spending run', () => {
    render(
      <RunSummaryRow
        run={summary({ id: 'run-2', dry: false, status: 'running', completedJobs: 3, totalCostUsd: 0.42 })}
        expanded={false}
        onToggle={() => {}}
      />,
    )
    const row = screen.getByTestId('evals-run-row-run-2')
    expect(row.textContent).toContain('REAL')
    expect(row.textContent).toContain('running')
    expect(row.textContent).toContain('3/8')
    expect(row.textContent).toContain('$0.42')
  })
})

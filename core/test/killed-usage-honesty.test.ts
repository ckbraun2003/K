/**
 * fix-b — killed-run usage honesty.
 *
 * A run KILLED mid-turn never emits the authoritative turn-end `result` (usage) line, so
 * `accumulate` leaves its totals at 0 — a misleading "0 tokens / $0" for real work.
 *
 * Route 1 (supervisor.reconcileKilledUsage): the claude stream DOES carry per-message usage
 * on each `assistant` line, so the supervisor tracks the LAST such interim usage and, on a
 * killed terminal that never summed a `result`, recovers it — the killed run records its real
 * observed tokens. Cost is NOT recoverable (the stream reports cost only on `result`), so a
 * mid-turn kill's cost stays honestly unmeasured (0).
 *
 * Route 2 residue (metrics.isUnmeasuredKilledRun): a run KILLED before ANY usage was ever
 * observed stays (0,0,0). Such a run is counted as a run but EXCLUDED from the measured
 * cost/token aggregates, so it is never a measured $0 that implies the work was free.
 */
import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@k/shared'
import { accumulate, accumulateInterimUsage, reconcileKilledUsage } from '../src/supervisor.js'
import {
  isUnmeasuredKilledRun, summarizeRuns, buildTimeseries, aggregateRouting,
  type RunRow, type TimeseriesRunRow, type RoutingRunRow,
} from '../src/metrics.js'

const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime()

// ── Route 1: interim-usage accumulation (output SUMMED, input MAX) ─────────────

/** Build an `assistant` AgentEvent carrying per-message usage. */
function assistantUsage(tokensIn: number | undefined, tokensOut: number | undefined): AgentEvent {
  return { id: 'a', runId: 'r', seq: 1, type: 'assistant', ts: NOW, tokensIn, tokensOut } as AgentEvent
}

describe('accumulateInterimUsage — output SUMMED across messages, input MAX (conservative)', () => {
  it('a single assistant message seeds the accumulator', () => {
    expect(accumulateInterimUsage(null, assistantUsage(100, 10))).toEqual({ tokensIn: 100, tokensOut: 10 })
  })

  it('multiple assistant messages: output tokens SUM, input tokens take the MAX', () => {
    // A killed turn that made two tool round-trips: tokensOut 10 then 15 → summed 25.
    // Input grows 100 → 120 → MAX 120 (not summed → never double-counts shared context).
    let acc = accumulateInterimUsage(null, assistantUsage(100, 10))
    acc = accumulateInterimUsage(acc, assistantUsage(120, 15))
    expect(acc).toEqual({ tokensIn: 120, tokensOut: 25 })
  })

  it('input takes MAX even if a later message reports a SMALLER input (never over-counts)', () => {
    let acc = accumulateInterimUsage(null, assistantUsage(200, 5))
    acc = accumulateInterimUsage(acc, assistantUsage(50, 7))
    expect(acc).toEqual({ tokensIn: 200, tokensOut: 12 }) // input MAX 200, output 5+7
  })

  it('a `result` (type usage) event does NOT feed the interim accumulator', () => {
    const result = { id: 'u', runId: 'r', seq: 2, type: 'usage', ts: NOW, tokensIn: 9999, tokensOut: 9999 } as AgentEvent
    const acc = { tokensIn: 120, tokensOut: 25 }
    expect(accumulateInterimUsage(acc, result)).toBe(acc) // unchanged (only assistant lines feed it)
  })

  it('a usage-less assistant event leaves the accumulator unchanged', () => {
    const acc = { tokensIn: 120, tokensOut: 25 }
    expect(accumulateInterimUsage(acc, assistantUsage(undefined, undefined))).toBe(acc)
  })

  it('end-to-end: fold a multi-message killed turn, then recover — output summed, input max', () => {
    // Mirror runAgent's stream loop: fold interim usage, no `result` ever seen (totals stay 0).
    const events = [assistantUsage(100, 10), assistantUsage(120, 15), assistantUsage(90, 4)]
    let interim: { tokensIn: number; tokensOut: number } | null = null
    for (const e of events) interim = accumulateInterimUsage(interim, e)
    expect(interim).toEqual({ tokensIn: 120, tokensOut: 29 }) // input MAX 120, output 10+15+4
    // On the killed terminal, recover it (no result was summed → totals are 0).
    expect(reconcileKilledUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, true, interim))
      .toEqual({ tokensIn: 120, tokensOut: 29, costUsd: 0 })
  })

  it('NO over-count when a `result` WAS summed: the interim accumulation is ignored', () => {
    // Same interim folding, but the run summed a real `result` (tokensIn>0) before the kill —
    // the authoritative totals win and interim is never added on top.
    let interim: { tokensIn: number; tokensOut: number } | null = null
    interim = accumulateInterimUsage(interim, assistantUsage(100, 10))
    interim = accumulateInterimUsage(interim, assistantUsage(120, 15))
    expect(reconcileKilledUsage({ tokensIn: 5000, tokensOut: 800, costUsd: 0.12 }, true, interim))
      .toEqual({ tokensIn: 5000, tokensOut: 800, costUsd: 0.12 })
  })

  it('a kill with no interim usage at all stays 0 — never fabricated', () => {
    let interim: { tokensIn: number; tokensOut: number } | null = null
    interim = accumulateInterimUsage(interim, assistantUsage(undefined, undefined)) // no usage seen
    expect(interim).toBeNull()
    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    expect(reconcileKilledUsage(totals, true, interim)).toBe(totals)
  })
})

// ── Route 1: reconcileKilledUsage (supervisor) ────────────────────────────────

describe('reconcileKilledUsage — killed-run interim-token recovery (Route 1)', () => {
  it('a killed run that never summed a `result` recovers the last interim assistant usage', () => {
    // accumulate() never ran (no `result` line) → totals are (0,0,0); the last assistant
    // line carried input=1200/output=340. On the killed terminal we recover those.
    const out = reconcileKilledUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, true, { tokensIn: 1200, tokensOut: 340 })
    expect(out).toEqual({ tokensIn: 1200, tokensOut: 340, costUsd: 0 })
  })

  it('cost is NEVER fabricated — a killed run keeps $0 (the stream has no interim cost)', () => {
    const out = reconcileKilledUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, true, { tokensIn: 999, tokensOut: 12 })
    expect(out.costUsd).toBe(0)
  })

  it('a killed run that DID sum a `result` keeps its totals (no double-count)', () => {
    // Completed an earlier turn (result summed → tokensIn>0) then killed mid-next-turn:
    // the summed totals are authoritative; interim usage is NOT folded in on top.
    const out = reconcileKilledUsage({ tokensIn: 5000, tokensOut: 800, costUsd: 0.12 }, true, { tokensIn: 1200, tokensOut: 340 })
    expect(out).toEqual({ tokensIn: 5000, tokensOut: 800, costUsd: 0.12 })
  })

  it('a NON-killed terminal is untouched (byte-identical to the prior completed-run path)', () => {
    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    expect(reconcileKilledUsage(totals, false, { tokensIn: 1200, tokensOut: 340 })).toBe(totals)
  })

  it('a kill with NO interim usage observed at all stays 0 — genuinely unmeasured, never fabricated', () => {
    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    expect(reconcileKilledUsage(totals, true, null)).toBe(totals)
  })

  it('mirrors the supervisor stream: an `assistant` line feeds interim usage; a `result` accumulates', () => {
    // Prove the two carriers are distinct — an assistant event carries interim tokens but does
    // NOT accumulate (only `result`/usage does), so the completed path is untouched while the
    // interim value is what a mid-turn kill recovers.
    const assistant: AgentEvent = {
      id: 'a', runId: 'r', seq: 1, type: 'assistant', ts: NOW, tokensIn: 1200, tokensOut: 340,
    } as AgentEvent
    // accumulate ignores the assistant event (not type 'usage')
    expect(accumulate({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, assistant)).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 })
    // but a killed terminal recovers that same interim usage
    expect(reconcileKilledUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, true, { tokensIn: assistant.tokensIn!, tokensOut: assistant.tokensOut! }))
      .toEqual({ tokensIn: 1200, tokensOut: 340, costUsd: 0 })
  })
})

// ── Route 2 residue: isUnmeasuredKilledRun (metrics) ──────────────────────────

describe('isUnmeasuredKilledRun — the never-observed-usage killed run', () => {
  const base = { status: 'killed', tokens_in: 0, tokens_out: 0, cost_usd: 0 }

  it('true only for a killed run with 0 tokens AND $0 cost', () => {
    expect(isUnmeasuredKilledRun(base)).toBe(true)
  })

  it('false for a killed run that observed usage (interim tokens recovered, or cost from a prior turn)', () => {
    expect(isUnmeasuredKilledRun({ ...base, tokens_in: 1200 })).toBe(false)
    expect(isUnmeasuredKilledRun({ ...base, tokens_out: 5 })).toBe(false)
    expect(isUnmeasuredKilledRun({ ...base, cost_usd: 0.03 })).toBe(false)
  })

  it('false for a non-killed run (done/error/interrupted), even at 0 cost', () => {
    expect(isUnmeasuredKilledRun({ ...base, status: 'done' })).toBe(false)
    expect(isUnmeasuredKilledRun({ ...base, status: 'error' })).toBe(false)
    expect(isUnmeasuredKilledRun({ ...base, status: 'interrupted' })).toBe(false)
  })
})

// ── metrics aggregation: excluded from MEASURED cost/token points, still a run ─

function runRow(p: Partial<RunRow>): RunRow {
  return { created_at: NOW, status: 'done', tokens_in: 100, tokens_out: 50, cost_usd: 0.01, ...p }
}
function tsRow(p: Partial<TimeseriesRunRow>): TimeseriesRunRow {
  return {
    created_at: NOW, status: 'done', tokens_in: 100, tokens_out: 50, cost_usd: 0.01,
    project_id: 'p1', project_name: 'P1', provider: 'claude', model: 'claude-sonnet-4-6', ...p,
  }
}
function routingRow(p: Partial<RoutingRunRow>): RoutingRunRow {
  return { provider: 'claude', model: 'sonnet', status: 'done', cost_usd: 0, created_at: NOW, ended_at: null, ...p }
}

describe('summarizeRuns — a killed-unmeasured run counts as a run but not as measured cost/tokens', () => {
  it('is counted in runs, contributes nothing to the day cost/token totals', () => {
    const s = summarizeRuns(
      [runRow({}), runRow({ status: 'killed', tokens_in: 0, tokens_out: 0, cost_usd: 0 })],
      NOW, { totalRuns: 2, activeRuns: 0 },
    )
    expect(s.today.runs).toBe(2)          // both runs counted
    expect(s.today.tokens).toBe(150)      // ONLY the completed run's 100+50 — killed contributes 0
    expect(s.today.costUsd).toBeCloseTo(0.01, 9) // ONLY the completed run's cost
  })

  it('a killed run that DID record usage (recovered interim) DOES count toward cost/tokens', () => {
    const s = summarizeRuns(
      [runRow({ status: 'killed', tokens_in: 1200, tokens_out: 340, cost_usd: 0 })],
      NOW, { totalRuns: 1, activeRuns: 0 },
    )
    expect(s.today.runs).toBe(1)
    expect(s.today.tokens).toBe(1540) // measured (recovered interim) tokens are included
  })
})

describe('buildTimeseries — killed-unmeasured excluded from series cost/token sums, still a run', () => {
  it('the series run count includes it; its cost/tokens do not', () => {
    const ts = buildTimeseries(
      [tsRow({}), tsRow({ status: 'killed', tokens_in: 0, tokens_out: 0, cost_usd: 0 })],
      NOW, 7, 'project',
    )
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].total.runs).toBe(2)
    expect(ts.series[0].total.tokens).toBe(150)          // only the completed run
    expect(ts.series[0].total.costUsd).toBeCloseTo(0.01, 9)
  })
})

describe('aggregateRouting — killed-unmeasured is not a measured $0 cost point', () => {
  it('avgCostUsd reflects only the measured run; the killed-$0 run does not drag it to 0', () => {
    const stats = aggregateRouting(
      [routingRow({ cost_usd: 0.04 }), routingRow({ status: 'killed', cost_usd: 0 })],
      NOW,
    )
    const g = stats.groups[0]
    expect(g.runs).toBe(2)                    // both runs counted
    expect(g.avgCostUsd).toBeCloseTo(0.04, 9) // NOT (0.04 + 0)/2 = 0.02 — killed-$0 excluded
    expect(g.totalCostUsd).toBeCloseTo(0.04, 9)
    // and the operator kill is excluded from the success denominator (existing F-082 rule)
    expect(g.terminalRuns).toBe(1)
    expect(g.successRate).toBe(1)
  })
})

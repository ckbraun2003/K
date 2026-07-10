/**
 * P3 W0a — the frozen Visibility wire contracts. Locks shapes + bounds so lane
 * implementations can't drift from the W0 freeze.
 */
import { describe, it, expect } from 'vitest'
import {
  RunNarrativeSchema, NarrativeBulletsSchema, NarrativeBulletsStateSchema,
  FeedKindSchema, FeedItemSchema, FeedPayloadSchema,
  CostRollupSchema, RecentActualsSchema, RecentActualsScopeSchema,
} from '@k/shared'

const RUN_ID = '11111111-2222-4333-8444-555555555555'

describe('P3 contracts (W0 freeze)', () => {
  it('RunNarrative: deterministic fields always; bullets nullable + labeled generated', () => {
    const deterministic = {
      runId: RUN_ID,
      goal: 'Add hello.js that prints hello',
      outcome: { status: 'done', endedAt: 200, durationMs: 100 },
      files: ['hello.js'],
      verification: { status: 'pass', reason: null, commandCount: 1 },
      cost: { costUsd: 0.0031, tokensIn: 1200, tokensOut: 340 },
      bullets: null,
      bulletsState: 'unavailable',
    }
    expect(RunNarrativeSchema.parse(deterministic)).toEqual(deterministic)
    // bullets present + labeled:
    const withBullets = { ...deterministic, bulletsState: 'ok',
      bullets: { decisions: ['chose fs.writeFile'], risks: ['no tests added'], generated: true, model: 'qwen2.5' } }
    expect(RunNarrativeSchema.parse(withBullets).bullets!.generated).toBe(true)
    // generated must be the literal true (never a raw model claim of falsity):
    expect(NarrativeBulletsSchema.safeParse({ decisions: [], risks: [], generated: false, model: 'x' }).success).toBe(false)
    // <=3 cap each side:
    expect(NarrativeBulletsSchema.safeParse({ decisions: ['a', 'b', 'c', 'd'], risks: [], generated: true, model: 'x' }).success).toBe(false)
    expect(NarrativeBulletsSchema.safeParse({ decisions: [], risks: ['a', 'b', 'c', 'd'], generated: true, model: 'x' }).success).toBe(false)
    expect(NarrativeBulletsStateSchema.options).toEqual(['ok', 'unavailable', 'disabled', 'error'])
    // verification nullable; outcome fields nullable where honest:
    expect(RunNarrativeSchema.safeParse({ ...deterministic, verification: null }).success).toBe(true)
    expect(RunNarrativeSchema.safeParse({ ...deterministic, outcome: { status: 'running', endedAt: null, durationMs: null } }).success).toBe(true)
  })

  it('FeedItem: 10 curated kinds, current runStatus carried, honest nulls', () => {
    expect(FeedKindSchema.options).toEqual(
      ['dispatch', 'park', 'plan_gate', 'review_ready', 'pr', 'merge', 'verify_pass', 'verify_fail', 'failure', 'done'])
    const item = {
      id: 'run:11111111:running', kind: 'dispatch', ts: 1000, runId: RUN_ID, runStatus: 'running',
      projectId: null, projectName: null, title: 'do the thing', detail: 'haiku',
    }
    expect(FeedItemSchema.parse(item)).toEqual(item)
    // a projectless notification item with no run:
    expect(FeedItemSchema.safeParse({ ...item, kind: 'failure', runId: null, runStatus: null, detail: null }).success).toBe(true)
    expect(FeedItemSchema.safeParse({ ...item, kind: 'mystery' }).success).toBe(false)
    const payload = FeedPayloadSchema.parse({
      items: [item],
      counts: { dispatch: 1, park: 0, plan_gate: 0, review_ready: 0, pr: 0, merge: 0, verify_pass: 0, verify_fail: 0, failure: 0, done: 0 },
      total: 1,
    })
    expect(payload.total).toBe(1)
  })

  it('CostRollup + RecentActuals: measured-only shapes, scope fallback tiers, null when n=0', () => {
    expect(CostRollupSchema.parse({
      windowDays: 14, groupBy: 'lead',
      buckets: [{ key: 'unassigned', label: 'Unassigned', costUsd: 0.5, runs: 3 }],
      totalCostUsd: 0.5,
    }).groupBy).toBe('lead')
    expect(CostRollupSchema.safeParse({ windowDays: 1, groupBy: 'model', buckets: [], totalCostUsd: 0 }).success).toBe(false)
    expect(RecentActualsScopeSchema.options).toEqual(['profile', 'project', 'global', 'none'])
    expect(RecentActualsSchema.parse({ scope: 'profile', n: 8, windowDays: 30, medianCostUsd: 0.004, p90CostUsd: 0.009 }).n).toBe(8)
    // n=0 => 'none' scope + null stats:
    expect(RecentActualsSchema.parse({ scope: 'none', n: 0, windowDays: 30, medianCostUsd: null, p90CostUsd: null }).medianCostUsd).toBeNull()
  })
})

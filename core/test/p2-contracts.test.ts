/**
 * P2 W0a — the frozen Human Gates wire contracts. Locks shapes + rejection rules
 * so lane implementations can't drift from the W0 freeze.
 */
import { describe, it, expect } from 'vitest'
import {
  RunStatusSchema, canonicalizeRunStatus, StartRunBodySchema, AgentProfileSchema,
  PrInfoSchema, PlanDocSchema, RunPlanSchema, UpdateRunPlanBodySchema,
  NotificationEventKeySchema, NotificationSchema, NotificationRuleSchema,
  UpdateNotificationRuleBodySchema, InboxItemSchema, InboxPayloadSchema,
  MergePrResultSchema, SetAutoMergeBodySchema, WsMessageSchema,
} from '@k/shared'

const RUN_ID = '11111111-2222-4333-8444-555555555555'

const PLAN = {
  steps: [{ title: 'Add the route', detail: 'routes/plan.ts' }, { title: 'Wire the test' }],
  files: ['core/src/routes/plan.ts', 'core/test/plan-routes.test.ts'],
  risk: 'low',
  notes: 'assumes W0 contracts landed',
}

describe('P2 contracts (W0 freeze)', () => {
  it('awaiting_plan is a RunStatus with the frozen canonical triple', () => {
    expect(RunStatusSchema.options).toContain('awaiting_plan')
    expect(canonicalizeRunStatus('awaiting_plan')).toEqual({
      state: 'waiting', attention: 'review_needed', health: 'ok',
    })
  })

  it('PlanDoc bounds: steps 1..50, risk enum, no unknown risk', () => {
    expect(PlanDocSchema.parse(PLAN)).toEqual(PLAN)
    expect(PlanDocSchema.safeParse({ ...PLAN, steps: [] }).success).toBe(false)
    expect(PlanDocSchema.safeParse({ ...PLAN, risk: 'extreme' }).success).toBe(false)
    expect(PlanDocSchema.safeParse({ steps: [{ title: 'x' }], files: [], risk: 'high' }).success).toBe(true)
  })

  it('RunPlan wire: nullable plan (unparseable turn), edited flag, approval stamp', () => {
    const wire = {
      runId: RUN_ID, plan: PLAN, raw: '```json\n{}\n```', edited: false,
      profileId: null, createdAt: 1, updatedAt: 1, approvedAt: null,
    }
    expect(RunPlanSchema.parse(wire)).toEqual(wire)
    expect(RunPlanSchema.safeParse({ ...wire, plan: null }).success).toBe(true)
  })

  it('UpdateRunPlanBody is strict and demands a full PlanDoc', () => {
    expect(UpdateRunPlanBodySchema.safeParse({ plan: PLAN }).success).toBe(true)
    expect(UpdateRunPlanBodySchema.safeParse({}).success).toBe(false)
    expect(UpdateRunPlanBodySchema.safeParse({ plan: PLAN, nope: 1 }).success).toBe(false)
  })

  it('StartRunBody.planGate + AgentProfile.planGate are optional booleans', () => {
    expect(StartRunBodySchema.parse({ prompt: 'x', planGate: true }).planGate).toBe(true)
    expect(StartRunBodySchema.parse({ prompt: 'x' }).planGate).toBeUndefined()
    expect(AgentProfileSchema.safeParse({
      id: 'p', name: 'p', tier: 'orchestrator', charter: 'orchestrator',
      defaultModel: null, allowedTools: [], mcpServers: [], skills: [], planGate: true,
    }).success).toBe(true)
  })

  it('notification contracts: 5 frozen P2 event keys + memory_saved (v11) + message_failed (ca-b B.2), rule channels, WS member', () => {
    expect(NotificationEventKeySchema.options).toEqual([
      'run_awaiting_input', 'run_awaiting_plan', 'run_review_ready', 'run_failed', 'verify_fail',
      'memory_saved', 'message_failed',
    ])
    const n = {
      id: RUN_ID, eventKey: 'run_awaiting_plan', title: 'Plan ready for review',
      body: 'add hello.js', runId: RUN_ID, projectId: null, createdAt: 1, readAt: null,
    }
    expect(NotificationSchema.parse(n)).toEqual(n)
    expect(NotificationRuleSchema.parse({ eventKey: 'verify_fail', inapp: true, browser: false }).browser).toBe(false)
    expect(UpdateNotificationRuleBodySchema.safeParse({}).success).toBe(false) // needs inapp or browser
    expect(UpdateNotificationRuleBodySchema.safeParse({ browser: true }).success).toBe(true)
    expect(WsMessageSchema.safeParse({ type: 'notification', notification: n, browser: true }).success).toBe(true)
  })

  it('InboxItem discriminates 5 kinds; payload counts mirror the kinds', () => {
    const common = { id: 'plan_pending:' + RUN_ID, ts: 1, projectId: null, projectName: null, title: 'do a thing' }
    expect(InboxItemSchema.safeParse({ ...common, kind: 'plan_pending', runId: RUN_ID, risk: 'low', steps: 2, edited: false }).success).toBe(true)
    expect(InboxItemSchema.safeParse({ ...common, kind: 'input_needed', runId: RUN_ID, model: 'm' }).success).toBe(true)
    expect(InboxItemSchema.safeParse({ ...common, kind: 'lesson_pending', lessonId: 'l1', profileName: null }).success).toBe(true)
    expect(InboxItemSchema.safeParse({ ...common, kind: 'mcp_trust', qualifiedKey: 'user:everything', sourceKind: 'claude-user', command: 'npx' }).success).toBe(true)
    expect(InboxItemSchema.safeParse({ ...common, kind: 'review_ready', runId: RUN_ID, verifyStatus: 'pass' }).success).toBe(true)
    expect(InboxItemSchema.safeParse({ ...common, kind: 'mystery' }).success).toBe(false)
    expect(InboxPayloadSchema.parse({
      items: [], counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0, proposal: 0 }, total: 0,
    }).total).toBe(0)
  })

  it('E-06 bodies: merge result + auto-merge toggle + PrInfo.headRefName optional', () => {
    expect(MergePrResultSchema.parse({ merged: true, number: 7 }).merged).toBe(true)
    expect(SetAutoMergeBodySchema.safeParse({ enabled: true }).success).toBe(true)
    expect(SetAutoMergeBodySchema.safeParse({}).success).toBe(false)
    // headRefName optional: pre-P2 cached PR payloads (github_cache) still parse.
    expect(PrInfoSchema.safeParse({ number: 1, title: 't', state: 'OPEN', url: 'https://x', checks: 'none' }).success).toBe(true)
    expect(PrInfoSchema.safeParse({ number: 1, title: 't', state: 'OPEN', url: 'https://x', checks: 'none', headRefName: 'k-review/12345678' }).success).toBe(true)
  })
})

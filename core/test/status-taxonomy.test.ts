/**
 * W0 (P0) — E-11 status taxonomy contract locks.
 *
 * Freezes the three canonical axes (entity state × attention × health) and the
 * exact legacy→canonical mapping tables, plus the two Lane seams W0 owns:
 * AgentEventType 'checkpoint' (Lane B) and VerifyRecipeSchema (E-04 groundwork).
 */
import { describe, it, expect } from 'vitest'
import {
  AgentEventTypeSchema, AgentRunStatusSchema, AttentionSchema, CanonicalStatusSchema,
  EntityStateSchema, HealthSchema, RunStatusSchema, VerifyRecipeSchema,
  canonicalizeAgentRunStatus, canonicalizeDelegationNodeStatus, canonicalizeRunStatus,
  canonicalizeWorkflowRunStatus,
} from '@k/shared'
import type { DelegationNodeStatus } from '@k/shared'

describe('E-11 canonical axes', () => {
  it('axes carry the frozen P0 vocabularies', () => {
    expect(EntityStateSchema.options).toEqual(['idle', 'queued', 'running', 'waiting', 'done', 'failed', 'stopped'])
    expect(AttentionSchema.options).toEqual(['none', 'input_needed', 'review_needed', 'blocked'])
    expect(HealthSchema.options).toEqual(['ok', 'degraded', 'broken', 'unknown'])
  })

  it('canonicalizeRunStatus maps every RunStatus to a valid triple — exact table', () => {
    for (const s of RunStatusSchema.options) {
      expect(CanonicalStatusSchema.safeParse(canonicalizeRunStatus(s)).success, s).toBe(true)
    }
    expect(canonicalizeRunStatus('queued')).toEqual({ state: 'queued', attention: 'none', health: 'ok' })
    expect(canonicalizeRunStatus('running')).toEqual({ state: 'running', attention: 'none', health: 'ok' })
    expect(canonicalizeRunStatus('awaiting_input')).toEqual({ state: 'waiting', attention: 'input_needed', health: 'ok' })
    expect(canonicalizeRunStatus('done')).toEqual({ state: 'done', attention: 'none', health: 'ok' })
    expect(canonicalizeRunStatus('error')).toEqual({ state: 'failed', attention: 'none', health: 'broken' })
    expect(canonicalizeRunStatus('killed')).toEqual({ state: 'stopped', attention: 'none', health: 'ok' })
    expect(canonicalizeRunStatus('interrupted')).toEqual({ state: 'stopped', attention: 'none', health: 'degraded' })
  })

  it('canonicalizeAgentRunStatus / WorkflowRunStatus cover their enums', () => {
    for (const s of AgentRunStatusSchema.options) {
      expect(CanonicalStatusSchema.safeParse(canonicalizeAgentRunStatus(s)).success, s).toBe(true)
      expect(canonicalizeWorkflowRunStatus(s)).toEqual(canonicalizeAgentRunStatus(s))
    }
    expect(canonicalizeAgentRunStatus('running')).toEqual({ state: 'running', attention: 'none', health: 'ok' })
    expect(canonicalizeAgentRunStatus('completed')).toEqual({ state: 'done', attention: 'none', health: 'ok' })
    expect(canonicalizeAgentRunStatus('failed')).toEqual({ state: 'failed', attention: 'none', health: 'broken' })
  })

  it('canonicalizeDelegationNodeStatus covers all five node statuses', () => {
    const all: DelegationNodeStatus[] = ['running', 'done', 'error', 'idle', 'queued']
    for (const s of all) {
      expect(CanonicalStatusSchema.safeParse(canonicalizeDelegationNodeStatus(s)).success, s).toBe(true)
    }
    expect(canonicalizeDelegationNodeStatus('error')).toEqual({ state: 'failed', attention: 'none', health: 'broken' })
    expect(canonicalizeDelegationNodeStatus('idle')).toEqual({ state: 'idle', attention: 'none', health: 'ok' })
    expect(canonicalizeDelegationNodeStatus('queued')).toEqual({ state: 'queued', attention: 'none', health: 'ok' })
  })

  it("AgentEventType gains 'checkpoint' (Lane B seam)", () => {
    expect(AgentEventTypeSchema.options).toContain('checkpoint')
  })

  it('VerifyRecipeSchema (E-04 groundwork) accepts a minimal recipe, rejects an empty one', () => {
    expect(VerifyRecipeSchema.safeParse({ commands: [{ label: 't', run: 'pnpm test' }] }).success).toBe(true)
    expect(VerifyRecipeSchema.safeParse({ commands: [] }).success).toBe(false)
    expect(VerifyRecipeSchema.safeParse({}).success).toBe(false)
  })
})

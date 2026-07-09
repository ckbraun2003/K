/**
 * E-11 (P0) — the SINGLE web status mapping is exhaustive over the enums and
 * preserves today's exact presentation values on the adopted surfaces.
 */
import { describe, it, expect } from 'vitest'
import { AgentRunStatusSchema, AttentionSchema, EntityStateSchema, HealthSchema, RunStatusSchema } from '@k/shared'
import type { DelegationNodeStatus } from '@k/shared'
import { agentRunStatusMeta, delegationStatusMeta, metaForCanonical, runStatusMeta } from '../src/lib/status'

const DELEGATION_STATUSES: DelegationNodeStatus[] = ['running', 'done', 'error', 'idle', 'queued']

describe('metaForCanonical exhaustiveness', () => {
  it('returns full meta for every state × attention × health combination', () => {
    for (const state of EntityStateSchema.options) {
      for (const attention of AttentionSchema.options) {
        for (const health of HealthSchema.options) {
          const m = metaForCanonical({ state, attention, health })
          expect(m.badge.length, `${state}/${attention}/${health}`).toBeGreaterThan(0)
          expect(m.dot.length).toBeGreaterThan(0)
          expect(m.text.length).toBeGreaterThan(0)
          expect(m.border.length).toBeGreaterThan(0)
          expect(typeof m.live).toBe('boolean')
        }
      }
    }
  })
})

describe('runStatusMeta (Runs surfaces)', () => {
  it('covers every RunStatus with a non-empty label', () => {
    for (const s of RunStatusSchema.options) {
      expect(runStatusMeta(s).label.length, s).toBeGreaterThan(0)
    }
  })
  it('preserves today’s exact presentation values', () => {
    expect(runStatusMeta('running').badge).toBe('bg-accent/15 text-[var(--accent-hover)]')
    expect(runStatusMeta('running').dot).toBe('bg-[var(--accent)] glow-live')
    expect(runStatusMeta('running').live).toBe(true)
    expect(runStatusMeta('awaiting_input').label).toBe('awaiting input')
    expect(runStatusMeta('awaiting_input').badge).toBe('bg-amber/25 text-[var(--amber)]')
    expect(runStatusMeta('awaiting_input').live).toBe(true)
    expect(runStatusMeta('awaiting_plan').label).toBe('plan ready')
    expect(runStatusMeta('awaiting_plan').badge).toBe('bg-amber/25 text-[var(--amber)]')
    expect(runStatusMeta('awaiting_plan').live).toBe(true)
    expect(runStatusMeta('queued').badge).toBe('bg-amber/15 text-[var(--amber)]')
    expect(runStatusMeta('done').badge).toBe('bg-green/15 text-[var(--green)]')
    expect(runStatusMeta('error').badge).toBe('bg-red/15 text-[var(--red)]')
    expect(runStatusMeta('killed').badge).toBe('bg-muted/15 text-[var(--muted)]')
    expect(runStatusMeta('interrupted').badge).toBe('bg-red/15 text-[var(--red)]')
    expect(runStatusMeta('killed').label).toBe('killed')
    expect(runStatusMeta('interrupted').label).toBe('interrupted')
  })
})

describe('agentRunStatusMeta / delegationStatusMeta (Chief surfaces)', () => {
  it('covers every AgentRunStatus and matches ChiefPage’s wake-row colors', () => {
    for (const s of AgentRunStatusSchema.options) {
      expect(agentRunStatusMeta(s).text.length, s).toBeGreaterThan(0)
    }
    expect(agentRunStatusMeta('completed').text).toBe('text-[var(--green)]')
    expect(agentRunStatusMeta('failed').text).toBe('text-[var(--red)]')
    expect(agentRunStatusMeta('running').text).toBe('text-[var(--accent-hover)]')
  })
  it('covers every DelegationNodeStatus and matches today’s tree classes', () => {
    for (const s of DELEGATION_STATUSES) {
      expect(delegationStatusMeta(s).border.length, s).toBeGreaterThan(0)
    }
    expect(delegationStatusMeta('done').border).toBe('border-[var(--green)]/50 text-[var(--green)]')
    expect(delegationStatusMeta('error').border).toBe('border-[var(--red)]/50 text-[var(--red)]')
    expect(delegationStatusMeta('queued').border).toBe('border-[var(--amber)]/50 text-[var(--amber)]')
    expect(delegationStatusMeta('running').border).toBe('border-[var(--accent)]/50 text-[var(--accent-hover)] glow-live')
    expect(delegationStatusMeta('idle').border).toBe('border-[var(--border)] text-[var(--muted)]')
  })
})

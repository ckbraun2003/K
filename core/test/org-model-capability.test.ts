/**
 * fix-a — org-role model capability (warn-only).
 *
 * An org-management role (Chief / lead) dispatched with a haiku-tier model can't reliably
 * drive the DEFERRED MCP management tools (lead_list / assign_lead / dispatch_lead / …), so
 * the autonomous K→Chief→lead chain silently stalls (live-observed). The decision is
 * WARN-ONLY: surface a clear warning but STILL dispatch exactly as configured. These tests
 * pin the predicate + the warn sink; the two dispatch choke-points that CALL the helper are
 * covered end-to-end in chief-wake.test.ts (Chief) and lead-dispatch-relay.test.ts (lead).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { isOrgToolCapableModel, warnIfOrgRoleModelNotToolCapable } from '../src/agent-config.js'

afterEach(() => { vi.restoreAllMocks() })

describe('isOrgToolCapableModel', () => {
  it('opus / sonnet / fable are tool-capable', () => {
    expect(isOrgToolCapableModel('claude-opus-4-8')).toBe(true)
    expect(isOrgToolCapableModel('claude-sonnet-4-6')).toBe(true)
    expect(isOrgToolCapableModel('claude-fable-5')).toBe(true)
  })

  it('the haiku tier is NOT tool-capable (dated snapshots included)', () => {
    expect(isOrgToolCapableModel('claude-haiku-4-5-20251001')).toBe(false)
    expect(isOrgToolCapableModel('claude-3-5-haiku-20241022')).toBe(false)
    expect(isOrgToolCapableModel('CLAUDE-HAIKU-9')).toBe(false) // case-insensitive family match
  })

  it('an absent/empty model is treated as capable (router resolves a default → nothing to warn)', () => {
    expect(isOrgToolCapableModel(null)).toBe(true)
    expect(isOrgToolCapableModel(undefined)).toBe(true)
    expect(isOrgToolCapableModel('')).toBe(true)
  })

  it('a non-haiku local model is capable (only the haiku family is flagged)', () => {
    expect(isOrgToolCapableModel('llama3.2')).toBe(true)
  })
})

describe('warnIfOrgRoleModelNotToolCapable', () => {
  it('a haiku model triggers the warning (names role, model id, consequence) and returns true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warned = warnIfOrgRoleModelNotToolCapable('Chief', 'claude-haiku-4-5-20251001')
    expect(warned).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('[org]')
    expect(msg).toContain('Chief')
    expect(msg).toContain('claude-haiku-4-5-20251001')
    expect(msg).toMatch(/deferred management tools/i)
    expect(msg).toMatch(/stall/i)
    expect(msg).toMatch(/sonnet\/opus/i)
  })

  it('a sonnet / opus model triggers NO warning and returns false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnIfOrgRoleModelNotToolCapable('Chief', 'claude-sonnet-4-6')).toBe(false)
    expect(warnIfOrgRoleModelNotToolCapable('Lead Backend (lead-backend)', 'claude-opus-4-8')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('is WARN-ONLY: it only reports — it never returns/alters a model, so dispatch is unchanged', () => {
    // The helper takes a role + the ALREADY-resolved model and returns a boolean; it has no
    // channel to change the model, tokens, or tool grants. Assert its return type + that the
    // haiku warning does not throw or mutate its inputs (the caller dispatches regardless).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = 'claude-haiku-4-5-20251001'
    const result = warnIfOrgRoleModelNotToolCapable('Chief', model)
    expect(typeof result).toBe('boolean')
    expect(model).toBe('claude-haiku-4-5-20251001') // input untouched
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

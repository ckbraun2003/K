/**
 * P2 A1 — plan-gate pure functions. No supervisor import, no spawns, no mocks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { buildPlanScaffold, parsePlanDoc, buildPlanContinuation, orgDefaultPlanGate, ORG_DEFAULT_PROFILE_ID } from '../src/plan-gate.js'
import { agentProfilesDb } from '../src/db.js'

const PLAN = {
  steps: [{ title: 'Add route', detail: 'routes/plan.ts' }, { title: 'Test it' }],
  files: ['a.ts'], risk: 'medium' as const, notes: 'watch the seam',
}
const fenced = (obj: unknown) => '```json\n' + JSON.stringify(obj, null, 2) + '\n```'

describe('buildPlanScaffold', () => {
  it('appends the scaffold AFTER the prompt and demands the fenced json shape', () => {
    const out = buildPlanScaffold('do the thing')
    expect(out.startsWith('do the thing')).toBe(true)
    expect(out).toContain('PLANNING PHASE')
    expect(out).toContain('"risk"')
    expect(out).toContain('Do NOT create, modify, or delete any files')
    // mount≠grant rider: the scaffold names no tools/servers/skills.
    expect(out).not.toMatch(/mcp__|Bash|WebSearch/)
  })
})

describe('parsePlanDoc', () => {
  it('parses the LAST fenced json block (models often echo an example first)', () => {
    const text = `thinking...\n${fenced({ steps: [{ title: 'wrong' }], files: [], risk: 'low' })}\nrevised:\n${fenced(PLAN)}\ndone.`
    expect(parsePlanDoc(text)).toEqual(PLAN)
  })
  it('returns null for no fence / broken json / schema-invalid json', () => {
    expect(parsePlanDoc('no plan here')).toBeNull()
    expect(parsePlanDoc('```json\n{ nope\n```')).toBeNull()
    expect(parsePlanDoc(fenced({ steps: [], files: [], risk: 'low' }))).toBeNull() // min(1) steps
  })
})

describe('buildPlanContinuation', () => {
  it('renders numbered steps + files and flags operator edits', () => {
    const out = buildPlanContinuation(PLAN, true)
    expect(out).toContain('REVIEWED AND EDITED')
    expect(out).toContain('1. Add route — routes/plan.ts')
    expect(out).toContain('2. Test it')
    expect(out).toContain('- a.ts')
    expect(out).toContain('Notes: watch the seam')
  })
  it('degrades honestly when the stored plan was unparseable', () => {
    const out = buildPlanContinuation(null, false)
    expect(out).toContain('approved')
    expect(out).toContain('plan you presented')
  })
})

describe('orgDefaultPlanGate', () => {
  const before = agentProfilesDb.getProfileRow.get(ORG_DEFAULT_PROFILE_ID) as { plan_gate?: number } | undefined
  afterEach(() => {
    if (before) agentProfilesDb.setProfilePlanGate.run(before.plan_gate ?? 0, ORG_DEFAULT_PROFILE_ID)
  })
  it('reads the org-default profile row (absent row = false)', () => {
    if (!before) { expect(orgDefaultPlanGate()).toBe(false); return }
    agentProfilesDb.setProfilePlanGate.run(1, ORG_DEFAULT_PROFILE_ID)
    expect(orgDefaultPlanGate()).toBe(true)
    agentProfilesDb.setProfilePlanGate.run(0, ORG_DEFAULT_PROFILE_ID)
    expect(orgDefaultPlanGate()).toBe(false)
  })
})

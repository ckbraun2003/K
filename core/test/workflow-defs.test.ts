/**
 * workflow-defs.ts + the generalized prompt builder (P5.3b).
 *
 * Behavior-preservation: renderWorkflowPrompt(CODE_WAVE_SCAFFOLD, tasks) is byte-identical
 * to buildDelegationPrompt(tasks) (the pre-P5.3b inline builder), asserted via the exact
 * substrings the existing workflows.test.ts pins + the numbered checklist + a $-safe title.
 * Plus the idempotent seed + updateWorkflowDef round-trip. Isolated DB via vitest.config.ts
 * K_DATA_DIR (shared file); the suite cleans up every row it touches.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, workflowDefsDb, rowToNamedWorkflow } from '../src/db.js'
import {
  buildDelegationPrompt,
  renderWorkflowPrompt,
  CODE_WAVE_SCAFFOLD,
  CHECKLIST_TOKEN,
} from '../src/workflows.js'
import {
  seedWorkflowDefinitions,
  listWorkflowDefs,
  getWorkflowDef,
  getWorkflowDefByName,
  updateWorkflowDef,
} from '../src/workflow-defs.js'
import type { ProjectTask } from '@k/shared'

const SEED_IDS = ['code-wave', 'investigate', 'refactor']
const testDefId = `wfdef-test-${uuid().slice(0, 8)}`

function makeTask(title: string): ProjectTask {
  return { id: uuid(), projectId: uuid(), title, status: 'open', createdAt: 0, completedAt: null }
}

beforeAll(() => {
  // Guarantee a clean slate for the idempotency assertion (a prior file may have left rows).
  for (const id of SEED_IDS) db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
})

afterAll(() => {
  for (const id of [...SEED_IDS, testDefId]) {
    db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
  }
})

describe('renderWorkflowPrompt / buildDelegationPrompt — behavior preservation', () => {
  it('buildDelegationPrompt renders CODE_WAVE_SCAFFOLD (byte-identical)', () => {
    const tasks = [makeTask('Fix the login bug')]
    expect(buildDelegationPrompt(tasks)).toBe(renderWorkflowPrompt(CODE_WAVE_SCAFFOLD, tasks))
  })

  it('carries every substring the existing builder guaranteed + the numbered checklist', () => {
    const titles = ['Add dark mode', 'Refactor auth', 'Write docs']
    const prompt = buildDelegationPrompt(titles.map(makeTask))
    // The exact substrings workflows.test.ts pins.
    expect(prompt).toContain('implementer → spec-review → quality-review')
    expect(prompt).toContain('NEVER push to a default branch')
    expect(prompt).toContain('ONE reviewable commit')
    expect(prompt).toContain('workflow_step_set')
    expect(prompt).toContain('workflow_status_set')
    // Numbered checklist lines.
    for (const t of titles) expect(prompt).toContain(t)
    expect(prompt).toContain('1. [ ] Add dark mode')
    expect(prompt).toContain('3. [ ] Write docs')
    // The token is fully consumed (no literal placeholder left behind).
    expect(prompt).not.toContain(CHECKLIST_TOKEN)
  })

  it('inserts a $-bearing title literally (no $&/$1 replacement-pattern corruption)', () => {
    const prompt = buildDelegationPrompt([makeTask('Fix $var handling')])
    expect(prompt).toContain('1. [ ] Fix $var handling')
  })

  it('throws on an empty task list (explicit contract guard)', () => {
    expect(() => renderWorkflowPrompt(CODE_WAVE_SCAFFOLD, [])).toThrow(/at least one task/)
    expect(() => buildDelegationPrompt([])).toThrow(/at least one task/)
  })
})

describe('seedWorkflowDefinitions — idempotent by name', () => {
  it('first call seeds the three built-ins; a second call seeds zero', () => {
    const first = seedWorkflowDefinitions()
    expect(first.sort()).toEqual(['Code wave', 'Investigate', 'Refactor'])
    const second = seedWorkflowDefinitions()
    expect(second).toEqual([])
  })

  it('listWorkflowDefs includes all three, and the code-wave scaffold renders the delegation prompt', () => {
    const names = listWorkflowDefs().map(w => w.name)
    for (const n of ['Code wave', 'Investigate', 'Refactor']) expect(names).toContain(n)

    const codeWave = getWorkflowDefByName('Code wave')!
    expect(codeWave.promptScaffold).toBe(CODE_WAVE_SCAFFOLD)
    const tasks = [makeTask('Task A'), makeTask('Task B')]
    expect(renderWorkflowPrompt(codeWave.promptScaffold, tasks)).toBe(buildDelegationPrompt(tasks))

    // The two extra scaffolds are real templates that carry the checklist token.
    expect(getWorkflowDefByName('Investigate')!.promptScaffold).toContain(CHECKLIST_TOKEN)
    expect(getWorkflowDefByName('Investigate')!.promptScaffold).toContain('Investigate')
    expect(getWorkflowDefByName('Refactor')!.promptScaffold).toContain(CHECKLIST_TOKEN)
  })
})

describe('updateWorkflowDef — round-trip', () => {
  it('persists a promptScaffold + crossProject change', () => {
    workflowDefsDb.insertWorkflowDef.run({
      id: testDefId,
      name: `test-wf-${testDefId}`,
      roles: JSON.stringify([{ id: 'r', label: 'R', description: 'd' }]),
      promptScaffold: `before {{CHECKLIST}}`,
      crossProject: 0,
      createdAt: Date.now(),
    })

    const updated = updateWorkflowDef(testDefId, {
      promptScaffold: `after {{CHECKLIST}} tail`,
      crossProject: true,
    })
    expect(updated).not.toBeNull()
    expect(updated!.promptScaffold).toBe('after {{CHECKLIST}} tail')
    expect(updated!.crossProject).toBe(true)
    // Roles + name were untouched (read-merge-write).
    expect(updated!.name).toBe(`test-wf-${testDefId}`)
    expect(updated!.roles).toEqual([{ id: 'r', label: 'R', description: 'd' }])

    // The durable row reflects the patch (via the mapper).
    const row = workflowDefsDb.getWorkflowDefRow.get(testDefId) as Record<string, unknown>
    expect(rowToNamedWorkflow(row).crossProject).toBe(true)
  })

  it('persists crossProject:false (the boolean is not clobbered by the ?? merge)', () => {
    // Start crossProject:true, then patch it back to false — a `||` merge would drop the
    // false and leave it true. This pins the `??` semantics against a future regression.
    updateWorkflowDef(testDefId, { crossProject: true })
    const off = updateWorkflowDef(testDefId, { crossProject: false })
    expect(off!.crossProject).toBe(false)
    // An unrelated patch leaves crossProject:false intact (not re-defaulted).
    const renamed = updateWorkflowDef(testDefId, { name: `renamed-${testDefId}` })
    expect(renamed!.crossProject).toBe(false)
  })

  it('returns null for an unknown id', () => {
    expect(updateWorkflowDef('no-such-wf', { crossProject: true })).toBeNull()
    expect(getWorkflowDef('no-such-wf')).toBeNull()
  })
})

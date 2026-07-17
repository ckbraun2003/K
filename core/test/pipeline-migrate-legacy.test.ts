/**
 * orch-p2 Lane A / Task A.4 — legacy → pipeline definition migration (TOKEN-FREE, DB-only).
 *
 * Every legacy NamedWorkflow (workflow_definitions with NULL spec) and every type:'workflow' skill
 * converts to a persisted, schema-valid PipelineSpec; the workflow-skill's routine re-homes onto a
 * pipeline def (pipeline_def_id set). Idempotent: a marker short-circuits, and per-row guards make
 * even a cleared-marker re-run create no duplicates.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PipelineSpecSchema } from '@k/shared'
import { db, workflowDefsDb, pipelineDb } from '../src/db.js'
import { registerSkill } from '../src/skills.js'
import { migrateLegacyDefs, mapRolesToSubagents, LEGACY_MIGRATION_MARKER } from '../src/pipeline-migrate-legacy.js'

const clearMarker = () => db.prepare(`DELETE FROM app_config WHERE key = ?`).run(LEGACY_MIGRATION_MARKER)
const defSpecOf = (id: string) => (pipelineDb.getDefSpec.get(id) as { spec: string | null } | undefined)?.spec ?? null
const pipelineDefIdOf = (skillId: string) =>
  (db.prepare(`SELECT pipeline_def_id FROM skills WHERE id = ?`).get(skillId) as { pipeline_def_id: string | null }).pipeline_def_id

function insertNamedWorkflow(name: string): string {
  const id = randomUUID()
  workflowDefsDb.insertWorkflowDef.run({
    id, name, roles: JSON.stringify([{ role: 'planner', description: 'plan it' }]),
    promptScaffold: 'Do the thing', crossProject: 0, createdAt: Date.now(),
  })
  return id
}

describe('legacy → pipeline migration (A.4)', () => {
  beforeEach(() => clearMarker())

  it('persists a lifted PipelineSpec on a NULL-spec NamedWorkflow row', () => {
    const id = insertNamedWorkflow('mig-nw-' + randomUUID().slice(0, 8))
    expect(defSpecOf(id)).toBeNull() // precondition
    migrateLegacyDefs()
    const spec = defSpecOf(id)
    expect(spec).not.toBeNull()
    const parsed = PipelineSpecSchema.safeParse(JSON.parse(spec!))
    expect(parsed.success).toBe(true)
    expect(parsed.data!.stages).toHaveLength(1)
    expect(parsed.data!.stages[0].kind).toBe('agent')
  })

  it('re-homes a type:workflow skill onto a pipeline def carrying a valid spec', () => {
    const name = 'mig-skill-' + randomUUID().slice(0, 8)
    const skill = registerSkill({ name, description: 'a scheduled workflow skill', type: 'workflow', source: 'x/SKILL.md', triggerType: 'schedule', schedule: '0 9 * * *' })
    migrateLegacyDefs()
    const defId = pipelineDefIdOf(skill.id)
    expect(defId).not.toBeNull()
    const defSpec = defSpecOf(defId!)
    expect(defSpec).not.toBeNull()
    expect(PipelineSpecSchema.safeParse(JSON.parse(defSpec!)).success).toBe(true)
  })

  it('is idempotent — marker short-circuits; a cleared-marker re-run makes no duplicates', () => {
    const wfId = insertNamedWorkflow('mig-idem-' + randomUUID().slice(0, 8))
    const skillName = 'mig-idem-skill-' + randomUUID().slice(0, 8)
    const skill = registerSkill({ name: skillName, description: 'd', type: 'workflow', source: 'y/SKILL.md', triggerType: 'manual' })

    const r1 = migrateLegacyDefs()
    expect(r1.skipped).toBe(false)
    const spec1 = defSpecOf(wfId)
    const defId1 = pipelineDefIdOf(skill.id)
    expect(spec1).not.toBeNull()
    expect(defId1).not.toBeNull()

    // Second run: the marker short-circuits the whole scan.
    expect(migrateLegacyDefs().skipped).toBe(true)

    // Clear the marker + re-run: per-row guards prevent any change / duplicate def rows.
    clearMarker()
    const before = (db.prepare(`SELECT COUNT(*) n FROM workflow_definitions WHERE name = ?`).get(skillName) as { n: number }).n
    const r3 = migrateLegacyDefs()
    expect(r3.skipped).toBe(false)
    expect(defSpecOf(wfId)).toBe(spec1)        // spec unchanged
    expect(pipelineDefIdOf(skill.id)).toBe(defId1) // same def, not re-created
    const after = (db.prepare(`SELECT COUNT(*) n FROM workflow_definitions WHERE name = ?`).get(skillName) as { n: number }).n
    expect(after).toBe(before)                  // no duplicate def
  })

  it('maps a stage role to a matching seeded worker as subagentType (leaves non-matches null)', () => {
    const workers = new Set(['implementer', 'planner'])
    const spec = PipelineSpecSchema.parse({
      name: 'x',
      stages: [
        { kind: 'agent', id: 'a', label: 'A', role: 'implementer', promptScaffold: 'go' },
        { kind: 'agent', id: 'b', label: 'B', role: 'nobody', promptScaffold: 'go' },
      ],
      edges: [{ from: 'a', to: 'b', handoff: 'share-tree' }, { from: 'b', to: 'done', handoff: 'share-tree' }],
      entry: 'a',
    })
    const mapped = mapRolesToSubagents(spec, workers)
    const a = mapped.stages.find(s => s.id === 'a') as { subagentType?: string | null }
    const b = mapped.stages.find(s => s.id === 'b') as { subagentType?: string | null }
    expect(a.subagentType).toBe('implementer')
    expect(b.subagentType ?? null).toBeNull()
  })
})

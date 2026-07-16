/**
 * One-time legacy → pipeline definition migration (Orchestration Program Phase 2, Lane A / A.4).
 *
 * Phase 2 makes pipelines the ONE definition system (design §4: convert + retire). Two legacy
 * stores fold into `workflow_definitions.spec` (the confirmed pipeline-def store, W0 Task 0.3):
 *
 *   1. NamedWorkflow templates — `workflow_definitions` rows whose `spec` is still NULL (they used
 *      to lazily compile via namedWorkflowToPipeline at read). Migration persists the lifted
 *      PipelineSpec eagerly, with a role→subagentType mapping applied where a stage's role matches
 *      a seeded worker bee.
 *   2. `type:'workflow'` skills — authored SKILL.md workflows in the `skills` table. Each gets a
 *      pipeline def (reusing a same-named workflow_definitions row if one exists, else a fresh one)
 *      and the skill row's `pipeline_def_id` is set so its routine RE-HOMES onto the pipeline (§7;
 *      the firing is Lane B's B.3 — this only re-points the target).
 *
 * Idempotent two ways: an app_config marker short-circuits the whole scan after the first run,
 * AND every per-row step is guarded (a non-NULL spec / non-NULL pipeline_def_id is skipped), so
 * even a cleared marker re-run creates no duplicates. Wired into boot after seedPipelineSpecs().
 */

import { randomUUID } from 'crypto'
import { namedWorkflowToPipeline, PipelineSpecSchema, type PipelineSpec, type NamedWorkflow } from '@k/shared'
import { db, pipelineDb, workflowDefsDb, rowToNamedWorkflow } from './db.js'
import { listSubAgents } from './sub-agents.js'

/** The app_config short-circuit marker (exported so tests can clear it to exercise re-runs). */
export const LEGACY_MIGRATION_MARKER = 'orch_p2_migrated_legacy_defs'

const getMarker = db.prepare(`SELECT 1 FROM app_config WHERE key = ?`)
const setMarker = db.prepare(`INSERT INTO app_config (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
const listWorkflowSkillRows = db.prepare(`SELECT * FROM skills WHERE type = 'workflow'`)
const setSkillPipelineDef = db.prepare(`UPDATE skills SET pipeline_def_id = @pipelineDefId WHERE id = @id`)

/** The set of seeded worker-bee (K-native) names a stage `role` can map onto as its subagentType. */
function seededWorkerNames(): Set<string> {
  return new Set(listSubAgents().filter(w => w.source === 'k').map(w => w.name))
}

/**
 * Apply role→subagentType mapping to a spec's agent stages: a stage whose `role` matches a seeded
 * worker's name (case-insensitive) adopts that worker as its `subagentType`. An explicit
 * subagentType is left intact; a non-matching role (e.g. the lifted single 'orchestrator' stage,
 * which runs top-level, not as a worker) keeps subagentType null. Exported for unit testing.
 */
export function mapRolesToSubagents(spec: PipelineSpec, workerNames: Set<string>): PipelineSpec {
  const lower = new Map([...workerNames].map(n => [n.toLowerCase(), n]))
  const stages = spec.stages.map(s => {
    if (s.kind !== 'agent' || s.subagentType != null) return s
    const match = lower.get(s.role.trim().toLowerCase())
    return match ? { ...s, subagentType: match } : s
  })
  return PipelineSpecSchema.parse({ ...spec, stages })
}

/** Lift a NamedWorkflow into a role-mapped, schema-valid PipelineSpec. */
function liftNamedWorkflow(nw: NamedWorkflow, workerNames: Set<string>): PipelineSpec {
  return mapRolesToSubagents(namedWorkflowToPipeline(nw), workerNames)
}

export interface LegacyMigrationResult {
  workflowsMigrated: number
  skillsRehomed: number
  skipped: boolean
}

/**
 * Convert every legacy NamedWorkflow + workflow-skill into a persisted PipelineSpec and re-home
 * workflow-skill routines onto pipeline defs. Idempotent (marker + per-row guards). Returns the
 * counts (or {skipped:true} when the marker already fired). Never throws on an individual bad row —
 * a malformed legacy row is left untouched (fail-safe), the rest still migrate.
 */
export function migrateLegacyDefs(): LegacyMigrationResult {
  if (getMarker.get(LEGACY_MIGRATION_MARKER)) return { workflowsMigrated: 0, skillsRehomed: 0, skipped: true }
  const workerNames = seededWorkerNames()
  let workflowsMigrated = 0
  let skillsRehomed = 0

  // 1) NamedWorkflow rows with a NULL spec → persist a lifted PipelineSpec.
  for (const row of workflowDefsDb.listWorkflowDefRows.all() as Record<string, unknown>[]) {
    if (row.spec != null) continue // already executable (seeded or previously migrated)
    try {
      const nw = rowToNamedWorkflow(row)
      pipelineDb.setDefSpec.run({ id: nw.id, spec: JSON.stringify(liftNamedWorkflow(nw, workerNames)) })
      workflowsMigrated++
    } catch (err) {
      console.warn(`[migrate-legacy] skipped workflow_definitions ${String(row.id)}:`, (err as Error).message)
    }
  }

  // 2) type='workflow' skills → ensure a pipeline def + re-home the routine (set pipeline_def_id).
  for (const srow of listWorkflowSkillRows.all() as Record<string, unknown>[]) {
    if (srow.pipeline_def_id != null) continue // already re-homed
    try {
      const skillId = String(srow.id)
      const name = String(srow.name)
      const description = srow.description == null ? '' : String(srow.description)
      // Reuse a same-named workflow_definitions row if one exists (ensuring it carries a spec),
      // else mint a fresh pipeline def for this workflow-skill.
      const existing = workflowDefsDb.getWorkflowDefByNameRow.get(name) as Record<string, unknown> | undefined
      let defId: string
      if (existing) {
        defId = String(existing.id)
        if (existing.spec == null) {
          pipelineDb.setDefSpec.run({ id: defId, spec: JSON.stringify(liftNamedWorkflow(rowToNamedWorkflow(existing), workerNames)) })
          workflowsMigrated++
        }
      } else {
        defId = randomUUID()
        const now = Date.now()
        const promptScaffold = description || `Run the "${name}" workflow.`
        const nw: NamedWorkflow = { id: defId, name, roles: [], promptScaffold, crossProject: false, createdAt: now }
        workflowDefsDb.insertWorkflowDef.run({ id: defId, name, roles: JSON.stringify([]), promptScaffold, crossProject: 0, createdAt: now })
        pipelineDb.setDefSpec.run({ id: defId, spec: JSON.stringify(liftNamedWorkflow(nw, workerNames)) })
      }
      setSkillPipelineDef.run({ id: skillId, pipelineDefId: defId })
      skillsRehomed++
    } catch (err) {
      console.warn(`[migrate-legacy] skipped workflow-skill ${String(srow.id)}:`, (err as Error).message)
    }
  }

  setMarker.run(LEGACY_MIGRATION_MARKER)
  return { workflowsMigrated, skillsRehomed, skipped: false }
}

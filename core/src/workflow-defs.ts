/**
 * Named workflow definitions — the DB-backed, operator-editable workflow TEMPLATE
 * registry (P5.3b, D-047). A NamedWorkflow names an ordered role list, a prompt
 * scaffold (rendered with the todo checklist at dispatch via renderWorkflowPrompt), and
 * a reserved cross_project flag (execution deferred).
 *
 * This is the DB entity DISTINCT from the @k/shared `WorkflowDefinition` roles+edges
 * DIAGRAM type — see the NamedWorkflow doc-comment in shared/src/types.ts.
 *
 * Registry: getWorkflowDef / getWorkflowDefByName / listWorkflowDefs / updateWorkflowDef,
 * plus seedWorkflowDefinitions() (idempotent, by name) which stands up the three built-in
 * templates — code-wave, investigate, refactor.
 */

import type { NamedWorkflow, WorkflowRole } from '@k/shared'
import { DELEGATION_WORKFLOW } from '@k/shared'
import { workflowDefsDb, rowToNamedWorkflow } from './db.js'
import { CODE_WAVE_SCAFFOLD } from './workflows.js'

// ─── Registry ────────────────────────────────────────────────────────────────

/** Look up a workflow definition by id (null if absent). */
export function getWorkflowDef(id: string): NamedWorkflow | null {
  const row = workflowDefsDb.getWorkflowDefRow.get(id) as Record<string, unknown> | undefined
  return row ? rowToNamedWorkflow(row) : null
}

/** Look up a workflow definition by its unique name (null if absent). */
export function getWorkflowDefByName(name: string): NamedWorkflow | null {
  const row = workflowDefsDb.getWorkflowDefByNameRow.get(name) as Record<string, unknown> | undefined
  return row ? rowToNamedWorkflow(row) : null
}

/** All workflow definitions, oldest first (seed order). */
export function listWorkflowDefs(): NamedWorkflow[] {
  return (workflowDefsDb.listWorkflowDefRows.all() as Record<string, unknown>[]).map(rowToNamedWorkflow)
}

/** Patch a workflow definition's mutable fields (name/roles/promptScaffold/crossProject).
 *  Unspecified fields keep their current value (read-merge-write, mirroring updateProfile).
 *  Returns the updated definition, or null if the id is unknown. */
export function updateWorkflowDef(
  id: string,
  patch: Partial<Pick<NamedWorkflow, 'name' | 'roles' | 'promptScaffold' | 'crossProject'>>,
): NamedWorkflow | null {
  const current = getWorkflowDef(id)
  if (!current) return null
  const merged = {
    name: patch.name ?? current.name,
    roles: patch.roles ?? current.roles,
    promptScaffold: patch.promptScaffold ?? current.promptScaffold,
    crossProject: patch.crossProject ?? current.crossProject,
  }
  workflowDefsDb.updateWorkflowDefRow.run({
    id,
    name: merged.name,
    roles: JSON.stringify(merged.roles),
    promptScaffold: merged.promptScaffold,
    crossProject: merged.crossProject ? 1 : 0,
  })
  return getWorkflowDef(id)
}

// ─── Seed ────────────────────────────────────────────────────────────────────

const INVESTIGATE_ROLES: WorkflowRole[] = [
  {
    id: 'investigator',
    label: 'Investigator',
    description: 'Explores the codebase / reproduces the issue and gathers evidence.',
  },
  {
    id: 'synthesizer',
    label: 'Synthesizer',
    description: 'Distills the investigation into findings and a recommended next step.',
  },
]

const INVESTIGATE_SCAFFOLD = [
  `You are the orchestrator of a research loop. Investigate the following items as a`,
  `single coordinated batch — do NOT change code, just gather evidence:`,
  ``,
  `{{CHECKLIST}}`,
  ``,
  `Spawn an Investigator to explore the codebase and reproduce each item, then a`,
  `Synthesizer to distill the investigation into findings and a recommended next step.`,
  `Report progress through the workflow status-write tools as you go.`,
].join('\n')

const REFACTOR_ROLES: WorkflowRole[] = [
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    description: 'Owns the refactor. Plans the change, dispatches the implementer, applies review fixes.',
  },
  {
    id: 'implementer',
    label: 'Implementer',
    description: 'Carries out the behavior-preserving code change against the plan in a focused context.',
  },
  {
    id: 'quality-review',
    label: 'Quality review',
    description: 'Reviews the change for behavior preservation, simplicity, and regressions.',
  },
]

const REFACTOR_SCAFFOLD = [
  `You are the orchestrator of a refactor loop. Address the following behavior-preserving`,
  `changes as a single coordinated batch:`,
  ``,
  `{{CHECKLIST}}`,
  ``,
  `Dispatch an Implementer to carry out each change, then a Quality reviewer to confirm`,
  `behavior is preserved with no regressions. Apply the reviewer's fixes yourself and ship`,
  `ONE reviewable commit / PR for the whole batch. Report progress through the workflow`,
  `status-write tools as you go.`,
].join('\n')

/** The three built-in workflow templates (pinned ids so the seed is stable). */
const SEED_WORKFLOWS: ReadonlyArray<{
  id: string
  name: string
  roles: WorkflowRole[]
  promptScaffold: string
  crossProject: boolean
}> = [
  {
    id: 'code-wave',
    name: 'Code wave',
    roles: DELEGATION_WORKFLOW.roles,
    promptScaffold: CODE_WAVE_SCAFFOLD,
    crossProject: false,
  },
  {
    id: 'investigate',
    name: 'Investigate',
    roles: INVESTIGATE_ROLES,
    promptScaffold: INVESTIGATE_SCAFFOLD,
    crossProject: false,
  },
  {
    id: 'refactor',
    name: 'Refactor',
    roles: REFACTOR_ROLES,
    promptScaffold: REFACTOR_SCAFFOLD,
    crossProject: false,
  },
]

/** Idempotently seed the built-in workflow templates. Existing rows (matched by name) are
 *  left untouched so operator edits survive restarts. Returns the names newly inserted.
 *  Called at bootstrap (index.ts), mirroring seedProfiles. */
export function seedWorkflowDefinitions(): string[] {
  const created: string[] = []
  for (const seed of SEED_WORKFLOWS) {
    if (getWorkflowDefByName(seed.name)) continue
    workflowDefsDb.insertWorkflowDef.run({
      id: seed.id,
      name: seed.name,
      roles: JSON.stringify(seed.roles),
      promptScaffold: seed.promptScaffold,
      crossProject: seed.crossProject ? 1 : 0,
      createdAt: Date.now(),
    })
    created.push(seed.name)
  }
  if (created.length) console.log(`[workflow-defs] seeded named workflows: ${created.join(', ')}`)
  return created
}

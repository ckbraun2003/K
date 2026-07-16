/**
 * The 3 built-in EXECUTABLE pipeline specs + their idempotent seed (D-119 Lane B, wave B1).
 *
 * These are the executable-DAG evolution of the legacy NamedWorkflow templates
 * (workflow-defs.ts SEED_WORKFLOWS): the SAME workflow_definitions row now also carries a
 * `spec` column holding a frozen PipelineSpec JSON. `code-wave` is the reference — parallel
 * `branch`→`merge` reviews around a merge-join controller, a declarative review gate, and a
 * deterministic verify tail. `investigate` and `refactor` are the linear + gated variants.
 *
 * Phase-1 as-built constraints (§3/§5) the reference specs deliberately respect:
 *   - NO `commit` / `ci` deterministic actions — those settle FAILED in the Phase-1 executor
 *     (pipeline-executor.ts). Agents open their own branch + PR per the lead charter, so a
 *     pipeline needs no dedicated commit/CI stage; only `agent` + `verify`/`command`
 *     deterministic + `gate` stages appear here.
 *   - NO repair-LOOP back-edges (deferred) — routing is FORWARD only (retry-in-place handles a
 *     transient stage failure; a rejected gate simply fails the pipeline and the operator
 *     re-runs). No edge points back at an already-passed upstream stage.
 *
 * Every spec is PipelineSpecSchema.parse'd at module load, so an authoring mistake fails FAST
 * at import (and boot) rather than at first dispatch, and the stored JSON is the canonical
 * (defaults-filled) form the executor re-validates per stage.
 */

import { PipelineSpecSchema, type PipelineSpec } from '@k/shared'
import { pipelineDb } from './db.js'
import { seedWorkflowDefinitions } from './workflow-defs.js'

// ─── Prompt scaffolds ──────────────────────────────────────────────────────────
// Each agent stage renders `{{GOAL}}` (the pipeline run's title) at dispatch
// (pipeline-executor.ts::renderScaffold). Role instructions mirror the DELEGATION_WORKFLOW
// role descriptions (shared/src/types.ts) — implementer implements + opens the PR, the
// reviewers emit fixes, the controller applies fixes + decides ready.

const IMPLEMENTER_SCAFFOLD = [
  `You are the implementer in a code-wave delegation loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Carry out the code change against the goal in a focused context. Branch off the`,
  `default branch, implement the change, and open ONE pull request (gh pr create) for`,
  `the whole wave — NEVER push to a default branch. Then hand your branch to the`,
  `reviewers.`,
].join('\n')

const SPEC_REVIEW_SCAFFOLD = [
  `You are the spec reviewer in a code-wave delegation loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the implementer's PR against the goal: does the change do exactly what was`,
  `asked, and nothing more? Emit concrete fixes for the controller to apply. Run every`,
  `wave, no exceptions.`,
].join('\n')

const QUALITY_REVIEW_SCAFFOLD = [
  `You are the quality reviewer in a code-wave delegation loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the implementer's PR for code quality, simplicity, and regressions. Emit`,
  `concrete fixes for the controller to apply. Run every wave, no exceptions.`,
].join('\n')

const CONTROLLER_SCAFFOLD = [
  `You are the controller of a code-wave delegation loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Apply the spec- and quality-reviewers' fixes to the implementer's PR yourself,`,
  `keeping ONE reviewable commit / PR for the whole wave. When the fixes are in and the`,
  `reviews are satisfied, decide the wave is ready to merge.`,
].join('\n')

const INVESTIGATOR_SCAFFOLD = [
  `You are the investigator of a research loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Explore the codebase and reproduce the issue. Do NOT change code — gather evidence`,
  `(logs, traces, failing cases) and hand your findings to the synthesizer.`,
].join('\n')

const SYNTHESIZER_SCAFFOLD = [
  `You are the synthesizer of a research loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Distill the investigator's evidence into clear findings and a single recommended`,
  `next step. Do NOT change code — produce the writeup.`,
].join('\n')

const PLANNER_SCAFFOLD = [
  `You are the planner of a refactor loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Plan the behavior-preserving change: identify the seams to touch and the invariants`,
  `to hold. Hand a concrete plan to the implementer. Do NOT change code yet.`,
].join('\n')

const REFACTOR_IMPLEMENTER_SCAFFOLD = [
  `You are the implementer of a refactor loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Carry out the behavior-preserving change against the plan in a focused context.`,
  `Branch off the default branch and open ONE pull request (gh pr create) — NEVER push`,
  `to a default branch. Then hand your branch to the quality reviewer.`,
].join('\n')

const REFACTOR_QUALITY_SCAFFOLD = [
  `You are the quality reviewer of a refactor loop.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the change for behavior preservation, simplicity, and regressions. Emit`,
  `concrete fixes and confirm no behavior drifted.`,
].join('\n')

// ─── The 3 executable specs ──────────────────────────────────────────────────────

/**
 * code-wave — the reference pipeline. implementer (retry ×2) fans OUT on `branch` to two
 * isolated review siblings, which fan IN on `merge` to the controller (a 3-way merge join of
 * both review trees); the controller's output passes a declarative review gate, then a
 * verify tail (retry ×2) runs the project's verifyRecipe before `done`. Forward routing only —
 * no repair back-edge (a rejected gate fails the pipeline; the operator re-runs).
 */
export const CODE_WAVE_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Code wave',
  version: 1,
  description: 'Reference delegation loop: implementer → parallel spec+quality reviews → merge-join controller → review gate → verify.',
  stages: [
    { kind: 'agent', id: 'implementer', label: 'Implementer', role: 'implementer', promptScaffold: IMPLEMENTER_SCAFFOLD, retry: { maxAttempts: 2 } },
    { kind: 'agent', id: 'spec-review', label: 'Spec review', role: 'spec-review', promptScaffold: SPEC_REVIEW_SCAFFOLD },
    { kind: 'agent', id: 'quality-review', label: 'Quality review', role: 'quality-review', promptScaffold: QUALITY_REVIEW_SCAFFOLD },
    { kind: 'agent', id: 'controller', label: 'Controller', role: 'controller', promptScaffold: CONTROLLER_SCAFFOLD },
    { kind: 'gate', id: 'gate-reviews', label: 'Reviews satisfied?', gate: { mode: 'declarative' } },
    { kind: 'deterministic', id: 'verify', label: 'Verify', action: { type: 'verify' }, retry: { maxAttempts: 2 } },
  ],
  edges: [
    { from: 'implementer', to: 'spec-review', handoff: 'branch', label: 'review' },
    { from: 'implementer', to: 'quality-review', handoff: 'branch', label: 'review' },
    { from: 'spec-review', to: 'controller', handoff: 'merge', label: 'fixes' },
    { from: 'quality-review', to: 'controller', handoff: 'merge', label: 'fixes' },
    { from: 'controller', to: 'gate-reviews', handoff: 'share-tree' },
    { from: 'gate-reviews', to: 'verify', handoff: 'share-tree', when: 'pass' },
    { from: 'verify', to: 'done', when: 'pass' },
  ],
  entry: 'implementer',
})

/** investigate — a linear research loop (no gate): investigator gathers evidence, the
 *  synthesizer distills it. share-tree handoff so the synthesizer sees the investigator's tree. */
export const INVESTIGATE_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Investigate',
  version: 1,
  description: 'Linear research loop: investigator gathers evidence → synthesizer distills findings.',
  stages: [
    { kind: 'agent', id: 'investigator', label: 'Investigator', role: 'investigator', promptScaffold: INVESTIGATOR_SCAFFOLD },
    { kind: 'agent', id: 'synthesizer', label: 'Synthesizer', role: 'synthesizer', promptScaffold: SYNTHESIZER_SCAFFOLD },
  ],
  edges: [
    { from: 'investigator', to: 'synthesizer', handoff: 'share-tree' },
    { from: 'synthesizer', to: 'done' },
  ],
  entry: 'investigator',
})

/** refactor — a linear behavior-preserving loop with a cleanliness gate + verify tail.
 *  planner → implementer (retry ×2) → quality-review → gate-clean → verify → done. */
export const REFACTOR_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Refactor',
  version: 1,
  description: 'Behavior-preserving loop: planner → implementer → quality review → clean gate → verify.',
  stages: [
    { kind: 'agent', id: 'planner', label: 'Planner', role: 'planner', promptScaffold: PLANNER_SCAFFOLD },
    { kind: 'agent', id: 'implementer', label: 'Implementer', role: 'implementer', promptScaffold: REFACTOR_IMPLEMENTER_SCAFFOLD, retry: { maxAttempts: 2 } },
    { kind: 'agent', id: 'quality-review', label: 'Quality review', role: 'quality-review', promptScaffold: REFACTOR_QUALITY_SCAFFOLD },
    { kind: 'gate', id: 'gate-clean', label: 'Clean & behavior-preserving?', gate: { mode: 'declarative' } },
    { kind: 'deterministic', id: 'verify', label: 'Verify', action: { type: 'verify' } },
  ],
  edges: [
    { from: 'planner', to: 'implementer', handoff: 'share-tree' },
    { from: 'implementer', to: 'quality-review', handoff: 'share-tree' },
    { from: 'quality-review', to: 'gate-clean', handoff: 'share-tree' },
    { from: 'gate-clean', to: 'verify', handoff: 'share-tree', when: 'pass' },
    { from: 'verify', to: 'done', when: 'pass' },
  ],
  entry: 'planner',
})

/** The built-in pipeline seeds, keyed on the SAME pinned ids as SEED_WORKFLOWS (workflow-defs.ts)
 *  so a spec is stored on its legacy NamedWorkflow's row. */
const PIPELINE_SEEDS: ReadonlyArray<{ id: string; name: string; spec: PipelineSpec }> = [
  { id: 'code-wave', name: 'Code wave', spec: CODE_WAVE_SPEC },
  { id: 'investigate', name: 'Investigate', spec: INVESTIGATE_SPEC },
  { id: 'refactor', name: 'Refactor', spec: REFACTOR_SPEC },
]

/**
 * Idempotently seed the 3 executable pipeline specs onto their workflow_definitions rows.
 * Mirrors seedWorkflowDefinitions' preserve-edits posture: the row is ensured first (that
 * seed is idempotent by name), then the `spec` column is written ONLY when it is still NULL —
 * an operator-edited spec is never clobbered on restart. Returns the names newly written.
 * Called at bootstrap (index.ts) right after seedWorkflowDefinitions().
 */
export function seedPipelineSpecs(): string[] {
  // Ensure the named workflow_definitions rows exist (idempotent by name). A pipeline spec
  // lives on the SAME row as its legacy NamedWorkflow template, so this must run first.
  seedWorkflowDefinitions()
  const written: string[] = []
  for (const seed of PIPELINE_SEEDS) {
    const row = pipelineDb.getDefSpec.get(seed.id) as { spec?: string | null } | undefined
    if (!row) continue // the def row is missing (should not happen post-seed) — skip defensively
    if (row.spec != null) continue // preserve an operator-edited spec (matches seedWorkflowDefinitions)
    pipelineDb.setDefSpec.run({ id: seed.id, spec: JSON.stringify(seed.spec) })
    written.push(seed.name)
  }
  if (written.length) console.log(`[pipeline-seeds] seeded executable pipeline specs: ${written.join(', ')}`)
  return written
}

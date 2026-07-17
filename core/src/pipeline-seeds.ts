/**
 * The standard executable pipeline library (D-119 Lane B wave B1 + orch-p2 Lane C task C.1)
 * + its idempotent seed.
 *
 * These are the executable-DAG evolution of the legacy NamedWorkflow templates
 * (workflow-defs.ts SEED_WORKFLOWS): the SAME workflow_definitions row now also carries a
 * `spec` column holding a frozen PipelineSpec JSON. `code-wave` is the reference — parallel
 * `branch`→`merge` reviews around a merge-join controller, a declarative review gate, and a
 * deterministic verify tail. `investigate` and `refactor` are linear + gated variants. The
 * six C.1 additions (`implementation-cycle`, `deep-research`, `bug-triage`, `security-audit`,
 * `quick-task`, evolved `refactor`) round out the library from design spec §5, using
 * `subagentType` to name a K-native worker (agent-config/agents/*.md) for stages that map
 * cleanly onto one, and `when:'loop'` + `maxIterations` (orch-p2 W0) for their bounded
 * refine/verify/critic loops.
 *
 * Phase-1 as-built constraints (§3/§5) every spec still respects:
 *   - NO `commit` / `ci` deterministic actions — those settle FAILED in the Phase-1 executor
 *     (pipeline-executor.ts). Agents open their own branch + PR per the lead charter, so a
 *     pipeline needs no dedicated commit/CI stage; only `agent` + `verify`/`command`
 *     deterministic + `gate` stages appear here.
 *   - NO repair-LOOP back-edges (`when:'repair'`, deferred) — a bounded `when:'loop'` back-edge
 *     (orch-p2 W0) is the supported way to author an intentional cycle; a rejected gate or an
 *     exhausted loop simply fails the pipeline and the operator re-runs.
 *
 * Every spec is PipelineSpecSchema.parse'd at module load, so an authoring mistake fails FAST
 * at import (and boot) rather than at first dispatch, and the stored JSON is the canonical
 * (defaults-filled) form the executor re-validates per stage.
 */

import { PipelineSpecSchema, type PipelineSpec, type StageDef, type WorkflowRole } from '@k/shared'
import { pipelineDb, workflowDefsDb } from './db.js'
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
  `to a default branch. Then hand your branch to the parallel tests + quality review.`,
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

// ── Implementation Cycle scaffolds ──────────────────────────────────────────────

const IC_PLAN_SCAFFOLD = [
  `You are the planner opening an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Turn the goal into a concrete, ordered implementation plan: files to touch, task`,
  `breakdown, interfaces, test strategy, risks. Hand the plan to the implementer. Do`,
  `NOT change code yet.`,
].join('\n')

const IC_IMPLEMENT_SCAFFOLD = [
  `You are the implementer in an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Carry out the plan in a focused context. Branch off the default branch, implement`,
  `the change, and open ONE pull request (gh pr create) for the whole cycle — NEVER`,
  `push to a default branch. Then hand your branch to the reviewers.`,
].join('\n')

const IC_SPEC_REVIEW_SCAFFOLD = [
  `You are the spec reviewer in an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the implementer's PR against the goal: does the change do exactly what was`,
  `asked, and nothing more? Emit concrete fixes for the controller to apply.`,
].join('\n')

const IC_SECURITY_REVIEW_SCAFFOLD = [
  `You are the security reviewer in an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the implementer's PR for injection, secrets, unsafe input handling, and`,
  `other security regressions. Emit concrete fixes for the controller to apply.`,
].join('\n')

const IC_QUALITY_REVIEW_SCAFFOLD = [
  `You are the quality reviewer in an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the implementer's PR for code quality, simplicity, and regressions. Emit`,
  `concrete fixes for the controller to apply.`,
].join('\n')

const IC_CONTROLLER_SCAFFOLD = [
  `You are the controller of an implementation cycle.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Apply the spec-, security-, and quality-reviewers' fixes to the implementer's PR`,
  `yourself, keeping ONE reviewable commit / PR for the whole cycle. If a reviewer`,
  `still has unresolved findings, the cycle loops back to the implementer for another`,
  `pass (bounded); once every review is satisfied, decide the cycle is ready to merge.`,
].join('\n')

// ── Deep Research scaffolds ─────────────────────────────────────────────────────

const DR_SCOPE_SCAFFOLD = [
  `You are scoping a research pipeline.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Turn the goal into a concrete research question and the specific angles worth`,
  `investigating in parallel. Do NOT investigate yet — hand the scoped angles to the`,
  `researchers.`,
].join('\n')

const DR_RESEARCHER_SCAFFOLD = [
  `You are a researcher in a deep-research pipeline.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Investigate your assigned angle independently — read code, logs, docs, or run`,
  `read-only commands as needed. Gather concrete evidence and hand your findings to`,
  `the synthesizer. Do NOT change code.`,
].join('\n')

const DR_SYNTHESIZE_SCAFFOLD = [
  `You are the synthesizer of a deep-research pipeline.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Distill the researchers' findings into one coherent picture: what is known, what`,
  `is still open, and where the evidence conflicts. Hand the synthesis to the`,
  `completeness critic.`,
].join('\n')

const DR_CRITIC_SCAFFOLD = [
  `You are the completeness critic of a deep-research pipeline.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Check the synthesis against the original goal: is any angle under-explored, any`,
  `claim unsupported? If real gaps remain, send it back for another research pass`,
  `(bounded); once the synthesis is dry (no more open threads worth chasing), pass it`,
  `to the report stage.`,
].join('\n')

const DR_REPORT_SCAFFOLD = [
  `You are writing the report for a deep-research pipeline.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Turn the synthesis into a clear, well-organized final writeup with a single`,
  `recommended next step. Do NOT change code — produce the writeup.`,
].join('\n')

// ── Bug Triage & Fix scaffolds ──────────────────────────────────────────────────

const BT_REPRODUCE_SCAFFOLD = [
  `You are reproducing a bug.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Reproduce the reported failure — a failing test, error, or unexpected behavior.`,
  `You are read-only: capture the exact repro steps and evidence (logs, stack traces,`,
  `failing cases) and hand them to the diagnosis stage. Do not patch anything.`,
].join('\n')

const BT_DIAGNOSE_SCAFFOLD = [
  `You are diagnosing a bug.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Follow the systematic-debugging skill to isolate the ROOT CAUSE of the reproduced`,
  `failure — not just the symptom. You are read-only: hand the root cause and the`,
  `minimal fix location to the implementer. Resist the urge to guess-and-patch.`,
].join('\n')

const BT_FIX_SCAFFOLD = [
  `You are fixing a bug.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Apply the minimal fix at the root cause the diagnosis stage identified. Branch off`,
  `the default branch and open ONE pull request (gh pr create) — NEVER push to a`,
  `default branch. Then hand your branch to verification.`,
].join('\n')

const BT_REVIEW_SCAFFOLD = [
  `You are reviewing a bug fix.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Review the fix for correctness, scope (does it fix the root cause without`,
  `overreaching?), and regressions now that verification is green. Emit concrete`,
  `fixes if anything remains.`,
].join('\n')

// ── Security Audit scaffolds ────────────────────────────────────────────────────

const SA_SCOPE_SCAFFOLD = [
  `You are scoping a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Identify what is in bounds for the audit — the surfaces, entry points, and trust`,
  `boundaries worth examining. Do NOT audit yet — hand the scope to the audit lenses.`,
].join('\n')

const SA_AUDIT_SECURITY_SCAFFOLD = [
  `You are the security lens of a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Audit the scoped surface for injection, secrets, unsafe crypto, auth/authorization`,
  `gaps, and OWASP-class vulnerabilities. Report concrete findings with severity and`,
  `location — do not change code.`,
].join('\n')

const SA_AUDIT_QUALITY_SCAFFOLD = [
  `You are the quality lens of a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Audit the scoped surface for defensive-coding gaps that widen the attack surface —`,
  `missing validation, unchecked errors, unsafe defaults. Report concrete findings`,
  `with severity and location — do not change code.`,
].join('\n')

const SA_AUDIT_SPEC_SCAFFOLD = [
  `You are the spec lens of a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Audit the scoped surface for behavior that diverges from its documented contract —`,
  `where a caller's trust assumptions could be violated. Report concrete findings`,
  `with severity and location — do not change code.`,
].join('\n')

const SA_ADVERSARIAL_VERIFY_SCAFFOLD = [
  `You are the adversarial verifier of a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Red-team the three lenses' findings: try to break or confirm each one, discard`,
  `false positives, and flag anything contested or unproven. If real findings are`,
  `still unconfirmed, send the audit back for another round (bounded); once every`,
  `finding is either confirmed or discarded, pass the confirmed set to synthesis.`,
].join('\n')

const SA_SYNTHESIZE_SCAFFOLD = [
  `You are synthesizing a security audit.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Turn the confirmed findings into one prioritized report: severity, location, and a`,
  `concrete recommended fix for each. Do NOT change code — produce the report.`,
].join('\n')

// ── Quick Task scaffold ─────────────────────────────────────────────────────────

const QT_SCAFFOLD = [
  `You are the sole worker on a quick task.`,
  ``,
  `Goal:`,
  `{{GOAL}}`,
  ``,
  `Carry out the goal directly in a focused context. No planning stage, no review`,
  `loop — just do the work and report the result.`,
].join('\n')

// ─── The executable specs ────────────────────────────────────────────────────────

/**
 * code-wave — the reference pipeline. implementer (retry ×2) fans OUT to two review siblings
 * that each `share-tree` (fork at the implementer's result_commit, so both reviewers INHERIT the
 * implementer's tree in isolation), which fan IN on `merge` to the controller (a 3-way merge join
 * of both review trees); the controller's output passes a declarative review gate, then a verify
 * tail (retry ×2) runs the project's verifyRecipe before `done`. Forward routing only — no repair
 * back-edge (a rejected gate fails the pipeline; the operator re-runs).
 *   NB: the reviewers use `share-tree` (fork at the UPSTREAM result), NOT `branch` (fork at the
 *   PIPELINE BASE) — a code reviewer must see the implementer's changes. `branch` is reserved for
 *   independent-from-clean-base parallel work, which no reference pipeline needs.
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
    { from: 'implementer', to: 'spec-review', handoff: 'share-tree', label: 'review' },
    { from: 'implementer', to: 'quality-review', handoff: 'share-tree', label: 'review' },
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

/** refactor — a behavior-preserving loop (design spec §5): impact analysis (K-native `planner`,
 *  read-only, mcp__gitnexus-equipped) → implementer (retry ×2) fans OUT to a parallel deterministic
 *  test run + a quality review, which fan IN on `merge` to a single clean/behavior-preserving gate.
 *  No loop — the spec's Refactor row is seq+parallel+gate only. */
export const REFACTOR_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Refactor',
  version: 1,
  description: 'Behavior-preserving loop: impact analysis → implement → parallel {tests, quality review} → clean gate.',
  stages: [
    { kind: 'agent', id: 'impact-analysis', label: 'Impact analysis', role: 'planner', subagentType: 'planner', promptScaffold: PLANNER_SCAFFOLD },
    { kind: 'agent', id: 'implementer', label: 'Implementer', role: 'implementer', subagentType: 'implementer', promptScaffold: REFACTOR_IMPLEMENTER_SCAFFOLD, retry: { maxAttempts: 2 } },
    { kind: 'deterministic', id: 'tests', label: 'Tests', action: { type: 'verify' } },
    { kind: 'agent', id: 'quality-review', label: 'Quality review', role: 'quality-review', subagentType: 'quality-reviewer', promptScaffold: REFACTOR_QUALITY_SCAFFOLD },
    { kind: 'gate', id: 'gate-clean', label: 'Clean & behavior-preserving?', gate: { mode: 'declarative' } },
  ],
  edges: [
    { from: 'impact-analysis', to: 'implementer', handoff: 'share-tree' },
    { from: 'implementer', to: 'tests', handoff: 'share-tree' },
    { from: 'implementer', to: 'quality-review', handoff: 'share-tree' },
    { from: 'tests', to: 'gate-clean', handoff: 'merge' },
    { from: 'quality-review', to: 'gate-clean', handoff: 'merge' },
    { from: 'gate-clean', to: 'done', when: 'pass' },
  ],
  entry: 'impact-analysis',
})

/**
 * implementation-cycle — design spec §5's richest reference pipeline (seq+parallel+loop+gate):
 * plan → implement (retry ×2) fans OUT to THREE parallel reviews (spec/security/quality, each
 * `share-tree` off the implementer) → merge-join controller (3-way fan-in) → a bounded `loop`
 * back to `implement` when the controller still has unresolved findings (maxIterations 3), with a
 * non-loop forward exit straight to a pre-merge approval gate → verify (retry ×2) → done.
 */
export const IMPLEMENTATION_CYCLE_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Implementation Cycle',
  version: 1,
  description: 'plan → implement → parallel {spec, security, quality} review → merge-join controller → bounded refine loop → pre-merge gate → verify.',
  stages: [
    { kind: 'agent', id: 'plan', label: 'Plan', role: 'planner', subagentType: 'planner', promptScaffold: IC_PLAN_SCAFFOLD },
    { kind: 'agent', id: 'implement', label: 'Implement', role: 'implementer', subagentType: 'implementer', promptScaffold: IC_IMPLEMENT_SCAFFOLD, retry: { maxAttempts: 2 } },
    { kind: 'agent', id: 'spec-review', label: 'Spec review', role: 'spec-review', subagentType: 'spec-reviewer', promptScaffold: IC_SPEC_REVIEW_SCAFFOLD },
    { kind: 'agent', id: 'security-review', label: 'Security review', role: 'security-review', subagentType: 'security-reviewer', promptScaffold: IC_SECURITY_REVIEW_SCAFFOLD },
    { kind: 'agent', id: 'quality-review', label: 'Quality review', role: 'quality-review', subagentType: 'quality-reviewer', promptScaffold: IC_QUALITY_REVIEW_SCAFFOLD },
    { kind: 'agent', id: 'controller', label: 'Controller', role: 'controller', promptScaffold: IC_CONTROLLER_SCAFFOLD },
    { kind: 'gate', id: 'gate-premerge', label: 'Pre-merge approval', gate: { mode: 'declarative' } },
    { kind: 'deterministic', id: 'verify', label: 'Verify', action: { type: 'verify' }, retry: { maxAttempts: 2 } },
  ],
  edges: [
    { from: 'plan', to: 'implement', handoff: 'share-tree' },
    { from: 'implement', to: 'spec-review', handoff: 'share-tree', label: 'review' },
    { from: 'implement', to: 'security-review', handoff: 'share-tree', label: 'review' },
    { from: 'implement', to: 'quality-review', handoff: 'share-tree', label: 'review' },
    { from: 'spec-review', to: 'controller', handoff: 'merge', label: 'fixes' },
    { from: 'security-review', to: 'controller', handoff: 'merge', label: 'fixes' },
    { from: 'quality-review', to: 'controller', handoff: 'merge', label: 'fixes' },
    { from: 'controller', to: 'implement', handoff: 'share-tree', when: 'loop', maxIterations: 3, label: 'refine' },
    { from: 'controller', to: 'gate-premerge', handoff: 'share-tree' },
    { from: 'gate-premerge', to: 'verify', handoff: 'share-tree', when: 'pass' },
    { from: 'verify', to: 'done', when: 'pass' },
  ],
  entry: 'plan',
})

/**
 * deep-research — design spec §5 (parallel+loop): scope fans OUT (`branch`, independent angles)
 * to two parallel researchers, which fan IN on `merge` to synthesize → a bounded `loop` back to
 * `synthesize` from the completeness critic when real gaps remain (maxIterations 3), with a
 * non-loop forward exit to the report stage → a report-approval gate → done.
 */
export const DEEP_RESEARCH_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Deep Research',
  version: 1,
  description: 'scope → parallel researchers → synthesize → bounded completeness-critic loop → report → gate.',
  stages: [
    { kind: 'agent', id: 'scope', label: 'Scope', role: 'scope', promptScaffold: DR_SCOPE_SCAFFOLD },
    { kind: 'agent', id: 'researcher-a', label: 'Researcher A', role: 'researcher', promptScaffold: DR_RESEARCHER_SCAFFOLD },
    { kind: 'agent', id: 'researcher-b', label: 'Researcher B', role: 'researcher', promptScaffold: DR_RESEARCHER_SCAFFOLD },
    { kind: 'agent', id: 'synthesize', label: 'Synthesize', role: 'synthesizer', promptScaffold: DR_SYNTHESIZE_SCAFFOLD },
    { kind: 'agent', id: 'completeness-critic', label: 'Completeness critic', role: 'critic', promptScaffold: DR_CRITIC_SCAFFOLD },
    { kind: 'agent', id: 'report', label: 'Report', role: 'reporter', promptScaffold: DR_REPORT_SCAFFOLD },
    { kind: 'gate', id: 'gate-report', label: 'Report approved?', gate: { mode: 'declarative' } },
  ],
  edges: [
    { from: 'scope', to: 'researcher-a', handoff: 'branch' },
    { from: 'scope', to: 'researcher-b', handoff: 'branch' },
    { from: 'researcher-a', to: 'synthesize', handoff: 'merge' },
    { from: 'researcher-b', to: 'synthesize', handoff: 'merge' },
    { from: 'synthesize', to: 'completeness-critic', handoff: 'share-tree' },
    { from: 'completeness-critic', to: 'synthesize', handoff: 'share-tree', when: 'loop', maxIterations: 3, label: 'loop-until-dry' },
    { from: 'completeness-critic', to: 'report', handoff: 'share-tree' },
    { from: 'report', to: 'gate-report', handoff: 'share-tree' },
    { from: 'gate-report', to: 'done', when: 'pass' },
  ],
  entry: 'scope',
})

/**
 * bug-triage — design spec §5 (seq+loop): reproduce (K-native `debugger`) → diagnose (same
 * discipline, isolates the root cause) → fix (K-native `implementer`, retry ×2) → a deterministic
 * verify stage with a bounded `loop` back to `fix` while it fails (maxIterations 3) and a
 * non-loop forward exit to review once green → a fix-approval gate → done.
 */
export const BUG_TRIAGE_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Bug Triage & Fix',
  version: 1,
  description: 'reproduce → diagnose → fix → bounded verify loop until green → review → gate.',
  stages: [
    { kind: 'agent', id: 'reproduce', label: 'Reproduce', role: 'debugger', subagentType: 'debugger', promptScaffold: BT_REPRODUCE_SCAFFOLD },
    { kind: 'agent', id: 'diagnose', label: 'Diagnose', role: 'debugger', subagentType: 'debugger', promptScaffold: BT_DIAGNOSE_SCAFFOLD },
    { kind: 'agent', id: 'fix', label: 'Fix', role: 'implementer', subagentType: 'implementer', promptScaffold: BT_FIX_SCAFFOLD, retry: { maxAttempts: 2 } },
    { kind: 'deterministic', id: 'verify', label: 'Verify', action: { type: 'verify' } },
    { kind: 'agent', id: 'review', label: 'Review', role: 'quality-review', subagentType: 'quality-reviewer', promptScaffold: BT_REVIEW_SCAFFOLD },
    { kind: 'gate', id: 'gate-done', label: 'Fix approved?', gate: { mode: 'declarative' } },
  ],
  edges: [
    { from: 'reproduce', to: 'diagnose', handoff: 'share-tree' },
    { from: 'diagnose', to: 'fix', handoff: 'share-tree' },
    { from: 'fix', to: 'verify', handoff: 'share-tree' },
    { from: 'verify', to: 'fix', handoff: 'share-tree', when: 'loop', maxIterations: 3, label: 'retry until green' },
    { from: 'verify', to: 'review', handoff: 'share-tree', when: 'pass' },
    { from: 'review', to: 'gate-done', handoff: 'share-tree' },
    { from: 'gate-done', to: 'done', when: 'pass' },
  ],
  entry: 'reproduce',
})

/**
 * security-audit — design spec §5 (parallel+loop): scope fans OUT (`branch`, independent lenses)
 * to three parallel audit lenses (security/quality/spec), which fan IN on `merge` to an
 * adversarial verifier — a bounded `loop` back to `scope` (re-running the whole round) while real
 * findings are still contested (maxIterations 3), with a non-loop forward exit to synthesis once
 * every finding is confirmed or discarded → a findings-confirmed gate → done.
 */
export const SECURITY_AUDIT_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Security Audit',
  version: 1,
  description: 'scope → parallel audit lenses → adversarial verify (bounded loop on contested findings) → synthesize → gate.',
  stages: [
    { kind: 'agent', id: 'scope', label: 'Scope', role: 'scope', promptScaffold: SA_SCOPE_SCAFFOLD },
    { kind: 'agent', id: 'audit-security', label: 'Security lens', role: 'security-review', subagentType: 'security-reviewer', promptScaffold: SA_AUDIT_SECURITY_SCAFFOLD },
    { kind: 'agent', id: 'audit-quality', label: 'Quality lens', role: 'quality-review', subagentType: 'quality-reviewer', promptScaffold: SA_AUDIT_QUALITY_SCAFFOLD },
    { kind: 'agent', id: 'audit-spec', label: 'Spec lens', role: 'spec-review', subagentType: 'spec-reviewer', promptScaffold: SA_AUDIT_SPEC_SCAFFOLD },
    { kind: 'agent', id: 'adversarial-verify', label: 'Adversarial verify', role: 'security-review', subagentType: 'security-reviewer', promptScaffold: SA_ADVERSARIAL_VERIFY_SCAFFOLD },
    { kind: 'agent', id: 'synthesize', label: 'Synthesize', role: 'synthesizer', promptScaffold: SA_SYNTHESIZE_SCAFFOLD },
    { kind: 'gate', id: 'gate-report', label: 'Findings confirmed?', gate: { mode: 'declarative' } },
  ],
  edges: [
    { from: 'scope', to: 'audit-security', handoff: 'branch' },
    { from: 'scope', to: 'audit-quality', handoff: 'branch' },
    { from: 'scope', to: 'audit-spec', handoff: 'branch' },
    { from: 'audit-security', to: 'adversarial-verify', handoff: 'merge' },
    { from: 'audit-quality', to: 'adversarial-verify', handoff: 'merge' },
    { from: 'audit-spec', to: 'adversarial-verify', handoff: 'merge' },
    { from: 'adversarial-verify', to: 'scope', handoff: 'share-tree', when: 'loop', maxIterations: 3, label: 're-audit' },
    { from: 'adversarial-verify', to: 'synthesize', handoff: 'share-tree' },
    { from: 'synthesize', to: 'gate-report', handoff: 'share-tree' },
    { from: 'gate-report', to: 'done', when: 'pass' },
  ],
  entry: 'scope',
})

/** quick-task — design spec §5's simplest shape (single): one K-native `implementer` worker,
 *  one goal, no plan/review/gate. */
export const QUICK_TASK_SPEC: PipelineSpec = PipelineSpecSchema.parse({
  name: 'Quick Task',
  version: 1,
  description: 'A single worker carries out one goal directly — no plan, no review loop, no gate.',
  stages: [
    { kind: 'agent', id: 'task', label: 'Task', role: 'implementer', subagentType: 'implementer', promptScaffold: QT_SCAFFOLD },
  ],
  edges: [
    { from: 'task', to: 'done' },
  ],
  entry: 'task',
})

/** The built-in pipeline seeds. The 3 Phase-1 pipelines are keyed on the SAME pinned ids as
 *  SEED_WORKFLOWS (workflow-defs.ts) so their spec is stored on their legacy NamedWorkflow's row;
 *  the 6 C.1 additions have no legacy counterpart, so `seedPipelineSpecs` ensures their
 *  workflow_definitions row itself (see `ensureWorkflowDefRow` below). */
const PIPELINE_SEEDS: ReadonlyArray<{ id: string; name: string; spec: PipelineSpec }> = [
  { id: 'code-wave', name: 'Code wave', spec: CODE_WAVE_SPEC },
  { id: 'investigate', name: 'Investigate', spec: INVESTIGATE_SPEC },
  { id: 'refactor', name: 'Refactor', spec: REFACTOR_SPEC },
  { id: 'implementation-cycle', name: 'Implementation Cycle', spec: IMPLEMENTATION_CYCLE_SPEC },
  { id: 'deep-research', name: 'Deep Research', spec: DEEP_RESEARCH_SPEC },
  { id: 'bug-triage', name: 'Bug Triage & Fix', spec: BUG_TRIAGE_SPEC },
  { id: 'security-audit', name: 'Security Audit', spec: SECURITY_AUDIT_SPEC },
  { id: 'quick-task', name: 'Quick Task', spec: QUICK_TASK_SPEC },
]

/** A pipeline-native seed's `agent` stages, faithfully projected into the legacy WorkflowRole[]
 *  shape (`id`/`label`/`description` ← `id`/`label`/`role`) — never placeholder text, since a
 *  pre-C.1 workflow_definitions row is still readable by the legacy WorkflowsView UI until it is
 *  retired (task C.4). */
function rolesFromSpec(spec: PipelineSpec): WorkflowRole[] {
  return spec.stages
    .filter((s): s is Extract<StageDef, { kind: 'agent' }> => s.kind === 'agent')
    .map(s => ({ id: s.id, label: s.label, description: s.role }))
}

/** Idempotently ensure a seed's workflow_definitions row exists (matched by id, NOT name — a
 *  pipeline-native seed has no legacy SEED_WORKFLOWS counterpart for `seedWorkflowDefinitions`
 *  to have already created). A no-op once the row exists (covers both the 3 Phase-1 ids, which
 *  `seedWorkflowDefinitions` above already created, and a re-seed of the 6 C.1 additions). */
function ensureWorkflowDefRow(seed: { id: string; name: string; spec: PipelineSpec }): void {
  if (workflowDefsDb.getWorkflowDefRow.get(seed.id)) return
  workflowDefsDb.insertWorkflowDef.run({
    id: seed.id,
    name: seed.name,
    roles: JSON.stringify(rolesFromSpec(seed.spec)),
    promptScaffold: seed.spec.description ?? seed.name,
    crossProject: seed.spec.crossProject ? 1 : 0,
    createdAt: Date.now(),
  })
}

/**
 * Idempotently seed the executable pipeline specs onto their workflow_definitions rows.
 * Mirrors seedWorkflowDefinitions' preserve-edits posture: each row is ensured first (idempotent
 * by id), then the `spec` column is written ONLY when it is still NULL — an operator-edited spec
 * is never clobbered on restart. Returns the names newly written.
 * Called at bootstrap (index.ts) right after seedWorkflowDefinitions().
 */
export function seedPipelineSpecs(): string[] {
  // Ensure the 3 Phase-1 named workflow_definitions rows exist (idempotent by name) — a legacy
  // pipeline spec lives on the SAME row as its NamedWorkflow template.
  seedWorkflowDefinitions()
  const written: string[] = []
  for (const seed of PIPELINE_SEEDS) {
    ensureWorkflowDefRow(seed) // no-op once the row exists, for every seed (legacy or C.1-native)
    const row = pipelineDb.getDefSpec.get(seed.id) as { spec?: string | null } | undefined
    if (!row) continue // defensive — ensureWorkflowDefRow above should make this unreachable
    if (row.spec != null) continue // preserve an operator-edited spec
    pipelineDb.setDefSpec.run({ id: seed.id, spec: JSON.stringify(seed.spec) })
    written.push(seed.name)
  }
  if (written.length) console.log(`[pipeline-seeds] seeded executable pipeline specs: ${written.join(', ')}`)
  return written
}

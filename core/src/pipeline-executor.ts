/**
 * StageExecutor seam + the Phase-1 WorktreeStageExecutor (D-119 Lane A, wave A1).
 *
 * The engine (wave A3) never names a worktree or spawns `execa` — it hands a
 * StageContext to a StageExecutor and reacts to the StageDispatchResult:
 *   - `supervised` — an agent (or hook-agent) mini-run was dispatched; the engine
 *     stamps `runs.pipeline_stage_id` and tracks the supervised run (A3 owns that —
 *     NOT wired here) and reacts to its terminal.
 *   - `settled`    — a zero-token deterministic/hook-script stage finished in a
 *     throwaway worktree; `resultCommit` is its terminal checkpoint SHA (the handoff
 *     hand-off), falling back to the fork base when nothing changed.
 *   - `parked`     — a gate stage parks at `awaiting_gate` (no run, no worktree); the
 *     engine (A5) owns gate resolution.
 *
 * The seam abstracts "turn a stage into work" so a DockerStageExecutor can satisfy
 * the same interface later (§3). Every deterministic / hook-script child runs under
 * `runChildEnv` (strips K_DATA_DIR/PORT/HARNESS_TOKEN — the H-1 live-DB guard) in a
 * FRESH detached worktree forked at the stage's `base_commit`, so a stage that runs
 * the repo's own tests can never bind vitest to the live k.db.
 */

import { execa } from 'execa'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { StageDefSchema, type StageDef, type PipelineHook } from '@k/shared'
import { startAgentRun } from './agent-runs.js'
import { addDetachedWorktree, removeWorktreeWithRetry, runChildEnv } from './supervisor.js'
import { createCheckpoint } from './checkpoints.js'
import { getProject } from './projects.js'
import { pipelineDb } from './db.js'

/** A materialized `pipeline_stages` row (the DDL columns, verbatim; db.ts:726). The
 *  engine mutates STATUS columns; `spec` is the frozen per-stage StageDef JSON. */
export interface PipelineStageRow {
  id: string
  pipeline_run_id: string
  stage_key: string
  kind: 'agent' | 'deterministic' | 'gate' | 'hook'
  profile_id: string | null
  spec: string
  status: string
  run_id: string | null
  base_commit: string | null
  result_commit: string | null
  exit_code: number | null
  failure_class: string | null
  retry_count: number
  repair_stage_key: string | null
  repairs_used: number
  gate_resolved_by: string | null
  gate_note: string | null
  cost_usd: number | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
}

/** What the executor needs to turn ONE stage into work. `baseCommit` is the per-edge
 *  handoff fork point (pipeline-handoff.ts computes it); `cwd` is the scoped project's
 *  localPath (the repo the worktrees are forked from). */
export interface StageContext {
  pipelineRunId: string
  stage: PipelineStageRow
  projectId: string | null
  cwd: string
  baseCommit: string | null
}

/** The outcome of dispatching a stage. `supervised` defers to the run lifecycle;
 *  `settled` is terminal in one call; `parked` waits on a human/programmatic gate. */
export type StageDispatchResult =
  | { kind: 'supervised'; runId: string }
  | { kind: 'settled'; status: 'passed' | 'failed'; resultCommit?: string; exitCode?: number; detail?: string }
  | { kind: 'parked'; status: 'awaiting_gate' }

export interface StageExecutor {
  readonly backend: 'worktree' | 'docker'
  dispatch(ctx: StageContext): Promise<StageDispatchResult>
  cancel(stageId: string): void
}

// A deterministic / hook-script child is time-bounded so a wedged shell (FS/AV stall)
// can't hang the engine — it SIGKILLs and the stage settles failed. Mirrors the verify
// engine's per-command budget (run-verify.ts).
const STAGE_CMD_TIMEOUT_MS = 5 * 60_000

/**
 * Map a StageDef `role` to a seeded durable profile id (profiles.ts SEED_PROFILES).
 * Only the discipline security-review has a dedicated lead; every other role runs
 * under the generic staff-engineer orchestrator. Used ONLY as the fallback when a
 * stage row / def carries no explicit `profile_id`. Exported for unit-testing.
 */
const ROLE_TO_PROFILE_ID: Record<string, string> = {
  orchestrator: 'default-orchestrator',
  planner: 'default-orchestrator',
  implementer: 'default-orchestrator',
  'spec-review': 'default-orchestrator',
  'quality-review': 'default-orchestrator',
  debugger: 'default-orchestrator',
  'security-review': 'lead-security',
}
export function roleToProfileId(role: string): string {
  return ROLE_TO_PROFILE_ID[role.trim().toLowerCase()] ?? 'default-orchestrator'
}

/** Substitute the pipeline goal into a stage's promptScaffold. `{{GOAL}}` (any inner
 *  whitespace) → the goal; an absent placeholder leaves the scaffold verbatim. */
function renderScaffold(scaffold: string, goal: string): string {
  return scaffold.replace(/\{\{\s*GOAL\s*\}\}/g, goal)
}

/** Parse a stage row's frozen `spec` JSON with the authoring schema. Defensive: a
 *  malformed / schema-invalid spec → null (the caller settles the stage failed rather
 *  than throwing). The stored spec is exactly one StageDef object. */
function parseStageDef(spec: string): StageDef | null {
  let raw: unknown
  try { raw = JSON.parse(spec) } catch { return null }
  const res = StageDefSchema.safeParse(raw)
  return res.success ? res.data : null
}

/**
 * The current git-worktree/process execution substrate (§3). Deterministic + hook
 * stages run in a throwaway detached worktree forked at the handoff base; agent +
 * hook-agent stages ride `startAgentRun`; gate stages park.
 */
export class WorktreeStageExecutor implements StageExecutor {
  readonly backend = 'worktree' as const

  // In-flight deterministic/hook-script children keyed by stage id, so cancel() can
  // SIGKILL a stage mid-run (agent runs are cancelled via the run lifecycle, not here).
  private readonly inFlight = new Map<string, ReturnType<typeof execa>>()

  async dispatch(ctx: StageContext): Promise<StageDispatchResult> {
    // The DB `kind` column is authoritative for routing; `spec` supplies the payload.
    switch (ctx.stage.kind) {
      case 'gate':
        // No run, no worktree — the engine (A5) resolves the park via a CAS.
        return { kind: 'parked', status: 'awaiting_gate' }
      case 'agent':
        return this.dispatchAgent(ctx)
      case 'deterministic':
        return this.dispatchDeterministic(ctx)
      case 'hook':
        return this.dispatchHook(ctx)
      default:
        return { kind: 'settled', status: 'failed', detail: `unknown stage kind: ${String(ctx.stage.kind)}` }
    }
  }

  cancel(stageId: string): void {
    const child = this.inFlight.get(stageId)
    if (!child) return
    try { child.kill('SIGKILL') } catch { /* best-effort — already gone */ }
  }

  // ── agent (and hook-agent) ────────────────────────────────────────────────────

  private async dispatchAgent(ctx: StageContext): Promise<StageDispatchResult> {
    const def = parseStageDef(ctx.stage.spec)
    if (!def || def.kind !== 'agent') {
      return { kind: 'settled', status: 'failed', detail: 'agent stage has an invalid spec' }
    }
    const profileId = ctx.stage.profile_id ?? def.profileId ?? roleToProfileId(def.role)
    // def.planGate is DEFERRED: startAgentRun derives planGate from the resolved
    // profile only (the profile's own plan-gate still applies). A per-stage planGate
    // override needs an additive option on the CRITICAL-risk startAgentRun hub and is
    // wired with the engine wave. TODO(A3).
    return this.dispatchSupervised(ctx, profileId, def.promptScaffold, def.model)
  }

  private async dispatchSupervised(
    ctx: StageContext, profileId: string, scaffold: string, model: string | null,
  ): Promise<StageDispatchResult> {
    const goal = renderScaffold(scaffold, this.resolveGoal(ctx))
    const { runId } = await startAgentRun(profileId, {
      trigger: 'delegation',
      goal,
      projectId: ctx.projectId ?? undefined,
      cwd: ctx.cwd,
      model: model ?? undefined,
      baseCommit: ctx.baseCommit ?? undefined,
    })
    // The engine (A3) stamps runs.pipeline_stage_id + trackSupervisedRun — NOT here.
    return { kind: 'supervised', runId }
  }

  /** The pipeline run's title is the operator/K goal `{{GOAL}}` renders from. */
  private resolveGoal(ctx: StageContext): string {
    const row = pipelineDb.getPipelineRun.get(ctx.pipelineRunId) as { title?: unknown } | undefined
    return typeof row?.title === 'string' ? row.title : ''
  }

  // ── deterministic ─────────────────────────────────────────────────────────────

  private async dispatchDeterministic(ctx: StageContext): Promise<StageDispatchResult> {
    const def = parseStageDef(ctx.stage.spec)
    if (!def || def.kind !== 'deterministic') {
      return { kind: 'settled', status: 'failed', detail: 'deterministic stage has an invalid spec' }
    }
    const action = def.action
    if (action.type === 'commit' || action.type === 'ci') {
      // TODO(A-later): commit needs a branch + commit; ci needs a PR push + gh run
      // polling — both land in a dedicated A wave with the branch/PR plumbing.
      return { kind: 'settled', status: 'failed', detail: 'commit/ci deterministic actions land in a later A wave' }
    }
    try {
      return await this.inThrowawayWorktree(ctx, async (wt) => {
        const exitCode = action.type === 'command'
          ? await this.runChild(ctx.stage.id, this.spawnShell(action.run, wt, STAGE_CMD_TIMEOUT_MS))
          : await this.runVerify(ctx, wt)
        const resultCommit = await this.snapshotHandoff(wt, ctx)
        return { kind: 'settled', status: exitCode === 0 ? 'passed' : 'failed', resultCommit, exitCode }
      })
    } catch (err) {
      return { kind: 'settled', status: 'failed', detail: `deterministic stage failed: ${(err as Error).message}` }
    }
  }

  /** action.type 'verify' — run the scoped project's verifyRecipe in the worktree;
   *  no project / no recipe → a no-op pass (exit 0). Fail-fast on the first failing
   *  command (its exit code is the stage's). */
  private async runVerify(ctx: StageContext, wt: string): Promise<number> {
    const recipe = ctx.projectId ? getProject(ctx.projectId)?.verifyRecipe : undefined
    if (!recipe || recipe.commands.length === 0) return 0
    for (const cmd of recipe.commands) {
      const exitCode = await this.runChild(ctx.stage.id, this.spawnShell(cmd.run, wt, recipe.timeoutMs ?? STAGE_CMD_TIMEOUT_MS))
      if (exitCode !== 0) return exitCode
    }
    return 0
  }

  // ── hook ──────────────────────────────────────────────────────────────────────

  private async dispatchHook(ctx: StageContext): Promise<StageDispatchResult> {
    const def = parseStageDef(ctx.stage.spec)
    if (!def || def.kind !== 'hook') {
      return { kind: 'settled', status: 'failed', detail: 'hook stage has an invalid spec' }
    }
    if (def.hook.type === 'agent') {
      const profileId = ctx.stage.profile_id ?? def.hook.profileId
      return this.dispatchSupervised(ctx, profileId, def.hook.promptScaffold, def.hook.model)
    }
    return this.dispatchHookScript(ctx, def.hook)
  }

  /** A hook-SCRIPT stage. A1 minimal pass-through: run the script like a deterministic
   *  command (HookContext on stdin), exit 0 → passed. TODO(Lane B): parse the stdout
   *  HookResult and apply the continue|inject|transform|gate contract (§6). */
  private async dispatchHookScript(
    ctx: StageContext, hook: Extract<PipelineHook, { type: 'script' }>,
  ): Promise<StageDispatchResult> {
    try {
      return await this.inThrowawayWorktree(ctx, async (wt) => {
        const hookCtx = JSON.stringify({ hook_event_name: 'PipelineStage', tool_name: null, tool_input: null, cwd: wt })
        const child = execa('node', [hook.file], {
          cwd: wt, input: hookCtx, env: runChildEnv(process.env, {}),
          timeout: hook.timeoutSec * 1000, killSignal: 'SIGKILL', reject: false,
        })
        const exitCode = await this.runChild(ctx.stage.id, child)
        return { kind: 'settled', status: exitCode === 0 ? 'passed' : 'failed', exitCode }
      })
    } catch (err) {
      return { kind: 'settled', status: 'failed', detail: `hook script failed: ${(err as Error).message}` }
    }
  }

  // ── worktree / child helpers ────────────────────────────────────────────────────

  /** Spawn a shell command in the worktree under the H-1-scrubbed env, time-bounded,
   *  non-rejecting (exit code carries pass/fail). */
  private spawnShell(run: string, cwd: string, timeout: number): ReturnType<typeof execa> {
    return execa(run, { cwd, shell: true, env: runChildEnv(process.env, {}), timeout, killSignal: 'SIGKILL', reject: false })
  }

  /** Register a child for cancel(), await it, return its exit code (killed/timed-out →
   *  1, i.e. failed). Always de-registers. */
  private async runChild(stageId: string, child: ReturnType<typeof execa>): Promise<number> {
    this.inFlight.set(stageId, child)
    try {
      const res = await child
      return res.exitCode ?? 1
    } finally {
      this.inFlight.delete(stageId)
    }
  }

  /** Snapshot the worktree as this stage's handoff commit (a checkpoint commit —
   *  reachable via refs/k-checkpoints/<stageId>, outlives the worktree). No changes →
   *  createCheckpoint returns null → the fork base IS the result. A checkpoint failure
   *  must never fail the stage (logged, base falls through). */
  private async snapshotHandoff(wt: string, ctx: StageContext): Promise<string | undefined> {
    let resultCommit = ctx.baseCommit ?? undefined
    try {
      const ck = await createCheckpoint(wt, ctx.stage.id, 1, null)
      if (ck) resultCommit = ck.sha
    } catch (err) {
      console.warn(`[pipeline-executor] handoff checkpoint failed (stage ${ctx.stage.id}):`, (err as Error).message)
    }
    return resultCommit
  }

  /** Fork a FRESH detached worktree at ctx.baseCommit, run `fn`, then always remove
   *  the worktree (retry the Windows EBUSY transient) + the temp dir. A fork failure
   *  propagates (the caller settles the stage failed). */
  private async inThrowawayWorktree<T>(ctx: StageContext, fn: (wt: string) => Promise<T>): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-stage-'))
    const wt = path.join(tmp, 'wt')
    try {
      await addDetachedWorktree(ctx.cwd, wt, ctx.baseCommit ?? undefined)
      return await fn(wt)
    } finally {
      await removeWorktreeWithRetry(() =>
        execa('git', ['-C', ctx.cwd, 'worktree', 'remove', '--force', wt]).then(() => undefined),
      )
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }
}

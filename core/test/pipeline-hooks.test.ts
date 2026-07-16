/**
 * D-119 Lane B / wave B3 — pipeline hook-STAGE executors (TOKEN-FREE).
 *
 * A hook-SCRIPT stage runs a tiny standalone node script in a throwaway worktree; the
 * script emits a structured HookResult on stdout, which the executor applies. No `claude`
 * ever spawns (the agent-hook path needs a live model). Real git against isolated
 * throwaway repos. Proves the §6 contract:
 *   a) {action:'continue'}            → settled passed;
 *   b) {action:'gate',pass:false}     → settled failed (detail carries the reason);
 *   c) {action:'transform',patch}     → settled passed AND result_commit tree carries the patch;
 *   d) a non-applying transform patch  → settled failed;
 *   e) a script emitting NOTHING       → exit 0 passed / exit 1 failed (A1 exit-code fallback);
 *   f) {action:'inject',context}       → settled passed and the context does NOT leak into the
 *                                        StageDispatchResult (cross-stage propagation is Phase-3);
 *   g) a 2-stage pipeline det → hook(gate pass:false) drives to `failed` (end-to-end via the engine).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WorktreeStageExecutor,
  type PipelineStageRow,
  type StageContext,
} from '../src/pipeline-executor.js'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { pipelineDb } from '../src/db.js'

const bases: string[] = []
let repo: string
let scriptsDir: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A materialized hook stage row with the columns the executor reads; the rest carry their
 *  DDL defaults so the shape is faithful (mirrors pipeline-executor.test.ts). */
function stageRow(over: Partial<PipelineStageRow> & Pick<PipelineStageRow, 'kind' | 'spec'>): PipelineStageRow {
  const now = Date.now()
  return {
    id: `stage-${Math.random().toString(36).slice(2)}`,
    pipeline_run_id: 'plr-test',
    stage_key: 'hook-stage',
    profile_id: null,
    status: 'pending',
    run_id: null,
    base_commit: null,
    result_commit: null,
    exit_code: null,
    failure_class: null,
    retry_count: 0,
    repair_stage_key: null,
    repairs_used: 0,
    gate_resolved_by: null,
    gate_note: null,
    cost_usd: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    ...over,
  }
}

function ctx(stage: PipelineStageRow): StageContext {
  return { pipelineRunId: 'plr-test', stage, projectId: null, cwd: repo, baseCommit }
}

/** Write a standalone node hook script. It drains stdin (the HookContext, ignored) then runs
 *  `body` — mirroring the gitnexus-hook read-stdin-then-emit shape, which also avoids an EPIPE. */
function writeScript(name: string, body: string): string {
  const file = path.join(scriptsDir, name)
  fs.writeFileSync(file, `try{require('fs').readFileSync(0,'utf-8')}catch{}\n${body}\n`)
  return file
}

/** A hook script that emits `result` as its stdout HookResult. */
function emitHook(name: string, result: unknown): string {
  return writeScript(name, `console.log(JSON.stringify(${JSON.stringify(result)}))`)
}

/** A hook StageDef `spec` string referencing `file` (the executor re-validates it with
 *  StageDefSchema, which fills the hooks/injection/retry defaults). */
function hookSpec(file: string): string {
  return JSON.stringify({ id: 'hook-stage', label: 'H', kind: 'hook', hook: { type: 'script', file, timeoutSec: 30 } })
}

function hookStage(file: string): PipelineStageRow {
  return stageRow({ kind: 'hook', base_commit: baseCommit, spec: hookSpec(file) })
}

function makeRepo(): { repo: string; baseCommit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-hooks-'))
  bases.push(base)
  const r = path.join(base, 'repo')
  fs.mkdirSync(r)
  scriptsDir = path.join(base, 'scripts')
  fs.mkdirSync(scriptsDir)
  git(r, ['init', '-q'])
  git(r, ['config', 'user.email', 'test@k.local'])
  git(r, ['config', 'user.name', 'K Test'])
  git(r, ['config', 'commit.gpgsign', 'false'])
  git(r, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(r, 'a.txt'), 'base\n')
  git(r, ['add', '.'])
  git(r, ['commit', '-q', '-m', 'init'])
  return { repo: r, baseCommit: git(r, ['rev-parse', 'HEAD']).trim() }
}

// Retire any leftover running pipelines (shared vitest DB) so drainPipelines in (g) only ever
// sees pipelines this file creates.
beforeAll(() => {
  const now = Date.now()
  for (const r of pipelineDb.listRunningPipelines.all() as Array<{ id: string }>) {
    pipelineDb.updatePipelineStatus.run({ id: r.id, status: 'cancelled', updatedAt: now, completedAt: now })
  }
})

beforeEach(() => {
  const made = makeRepo()
  repo = made.repo
  baseCommit = made.baseCommit
})

afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('WorktreeStageExecutor — hook-script contract', () => {
  it('a) {action:continue} settles passed (handoff falls back to base, no tree change)', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('continue.cjs', { action: 'continue' }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed')
    expect(res.resultCommit).toBe(baseCommit)
  })

  it('b) {action:gate,pass:false} settles failed and the detail carries the reason', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('gate-fail.cjs', { action: 'gate', gate: { pass: false, reason: 'policy violated' } }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('failed')
    expect(res.detail).toContain('policy violated')
  })

  it('b2) {action:gate,pass:true} settles passed', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('gate-pass.cjs', { action: 'gate', gate: { pass: true } }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed')
  })

  it('c) {action:transform,patch} applies the patch and the handoff tree carries the change', async () => {
    const patch =
      'diff --git a/a.txt b/a.txt\n' +
      '--- a/a.txt\n' +
      '+++ b/a.txt\n' +
      '@@ -1 +1,2 @@\n' +
      ' base\n' +
      '+added-by-hook\n'
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('transform.cjs', { action: 'transform', patch }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed')
    // A NEW checkpoint commit (the patched tree) — not the untouched base.
    expect(res.resultCommit).toBeTruthy()
    expect(res.resultCommit).not.toBe(baseCommit)
    expect(git(repo, ['show', `${res.resultCommit}:a.txt`])).toContain('added-by-hook')
    // Source repo HEAD is untouched (isolation).
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit)
  })

  it('d) a non-applying transform patch settles failed (never partially applied)', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('bad-patch.cjs', { action: 'transform', patch: 'this is not a valid unified diff\n' }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('failed')
    expect(res.detail).toMatch(/patch does not apply|git apply/)
  })

  it('e) a script emitting NOTHING falls back to the exit code: exit 0 passed, exit 1 failed', async () => {
    const exec = new WorktreeStageExecutor()
    const ok = await exec.dispatch(ctx(hookStage(writeScript('none0.cjs', 'process.exit(0)'))))
    if (ok.kind !== 'settled') throw new Error('expected settled')
    expect(ok.status).toBe('passed')
    expect(ok.exitCode).toBe(0)

    const bad = await exec.dispatch(ctx(hookStage(writeScript('none1.cjs', 'process.exit(1)'))))
    if (bad.kind !== 'settled') throw new Error('expected settled')
    expect(bad.status).toBe('failed')
    expect(bad.exitCode).toBe(1)
  })

  it('e2) malformed (non-JSON) stdout also falls back to the exit code', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(writeScript('garbage.cjs', "console.log('not json at all'); process.exit(0)"))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed') // exit 0 → passed via fallback
    expect(res.exitCode).toBe(0)
  })

  it('f) {action:inject} settles passed and the additionalContext does NOT leak into the result (Phase-3)', async () => {
    const exec = new WorktreeStageExecutor()
    const res = await exec.dispatch(ctx(hookStage(emitHook('inject.cjs', { action: 'inject', additionalContext: 'downstream should never see this' }))))
    if (res.kind !== 'settled') throw new Error('expected settled')
    expect(res.status).toBe('passed')
    expect(res.resultCommit).toBe(baseCommit) // no tree change
    // Cross-stage injection is GATED on Phase 3 — nothing about the context rides the result.
    expect('additionalContext' in res).toBe(false)
    expect(JSON.stringify(res)).not.toContain('downstream should never see this')
  })
})

describe('PipelineEngine — hook gate stage in a pipeline', () => {
  it('g) det → hook(gate pass:false) drives the whole pipeline to failed', async () => {
    const gateFail = emitHook('pl-gate-fail.cjs', { action: 'gate', gate: { pass: false, reason: 'blocked' } })
    const spec = {
      name: 'hook-gate',
      stages: [
        { kind: 'deterministic', id: 'det', label: 'noop', action: { type: 'command', run: 'node -e "process.exit(0)"' } },
        { kind: 'hook', id: 'hookgate', label: 'gate', hook: { type: 'script', file: gateFail, timeoutSec: 30 } },
      ],
      edges: [
        { from: 'det', to: 'hookgate', handoff: 'share-tree' },
        { from: 'hookgate', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'det',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'hook gate demo' })
    let status = 'running'
    for (let i = 0; i < 15 && status === 'running'; i++) {
      await drainPipelines()
      status = (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
    }
    expect(status).toBe('failed')
    const stages = pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
    expect(stages.find(s => s.stage_key === 'det')!.status).toBe('passed')
    expect(stages.find(s => s.stage_key === 'hookgate')!.status).toBe('failed')
  }, 60_000) // real worktree ops per stage — slow on Windows
})

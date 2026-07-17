/**
 * D-119 Lane A / wave A3 — PipelineEngine + scheduler + reconcile (TOKEN-FREE).
 *
 * Deterministic + gate stages only (no `claude` ever spawns — the agent path needs a live
 * model). Real git against isolated throwaway repos; the shared vitest DB carries the
 * pipeline ledger (unique UUIDs per test). Proves:
 *   a) a linear share-tree pipeline runs to `completed`, both stages `passed`, the handoff is
 *      carried (stage 2 sees stage 1's file), and the handoff refs live in the sweep-immune
 *      refs/k-pipelines/ namespace (survive sweepCheckpointRefs; reclaimed by sweepPipelineRefs);
 *   b) a branch→merge fan-out joins cleanly → `completed`, the merged tree carries both files;
 *   c) a gate stage parks at `awaiting_gate` and the pipeline stays `running`;
 *   d) reconcilePipelines fails a `dispatched`+null-run_id stage (never re-executes it) and
 *      derives a running stage whose linked run is terminal;
 *   e) dispatchStage stamps runs.pipeline_stage_id (the §10 ownership back-ref) for a
 *      supervised stage.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { dispatchStage, reconcilePipelines, type PipelineRunRow } from '../src/pipeline-engine.js'
import { pipelineDb, runsDb } from '../src/db.js'
import { sweepCheckpointRefs, sweepPipelineRefs } from '../src/checkpoints.js'
import type { StageExecutor, PipelineStageRow } from '../src/pipeline-executor.js'

const bases: string[] = []
let repo: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A cross-platform (cmd.exe + sh) child that writes a file. The throwaway worktree lives
 *  under a package.json-less temp dir, so `node -e` runs CommonJS (require resolves). */
const WRITE = (f: string) => `node -e "require('fs').writeFileSync('${f}','x')"`
const CHECK = (need: string[]) =>
  `node -e "const fs=require('fs'); if(${need.map(f => `!fs.existsSync('${f}')`).join('||')}) process.exit(9)"`
const CHECK_THEN_WRITE = (need: string[], write: string) =>
  `node -e "const fs=require('fs'); if(${need.map(f => `!fs.existsSync('${f}')`).join('||')}) process.exit(9); fs.writeFileSync('${write}','x')"`

function makeRepo(): { repo: string; baseCommit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-engine-'))
  bases.push(base)
  const r = path.join(base, 'repo')
  fs.mkdirSync(r)
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

// Clear any pre-existing running pipelines (leftover on the shared DB from a prior run) so
// drainPipelines only ever sees pipelines this file creates.
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

/** Drive the scheduler until the pipeline leaves 'running' (bounded). */
async function driveToTerminal(pipelineRunId: string, maxTicks = 15): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }
    if (run.status !== 'running') break
  }
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}

function stageByKey(pipelineRunId: string, key: string): PipelineStageRow {
  const s = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}

describe('PipelineEngine — linear share-tree', () => {
  it('a) runs to completed, carries the handoff, and keeps handoff refs sweep-immune', async () => {
    const spec = {
      name: 'linear',
      stages: [
        { kind: 'deterministic', id: 'det1', label: 'write A', action: { type: 'command', run: WRITE('fileA.txt') } },
        { kind: 'deterministic', id: 'det2', label: 'see A, write B', action: { type: 'command', run: CHECK_THEN_WRITE(['fileA.txt'], 'fileB.txt') } },
      ],
      edges: [
        { from: 'det1', to: 'det2', handoff: 'share-tree' },
        { from: 'det2', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'det1',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'linear demo' })
    const status = await driveToTerminal(pipelineRunId)

    expect(status).toBe('completed')
    expect(stageByKey(pipelineRunId, 'det1').status).toBe('passed')
    const det2 = stageByKey(pipelineRunId, 'det2')
    expect(det2.status).toBe('passed') // det2 exited 0 → it SAW fileA.txt (the handoff carried)
    // det2's result tree carries BOTH the carried file and its own output.
    const tree = git(repo, ['ls-tree', '-r', '--name-only', det2.result_commit!])
    expect(tree).toContain('fileA.txt')
    expect(tree).toContain('fileB.txt')

    // Handoff refs live in refs/k-pipelines/, NOT refs/k-checkpoints/ (which was moved away).
    const plRefs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/k-pipelines/']).trim()
    expect(plRefs).not.toBe('')
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/k-checkpoints/']).trim()).toBe('')
    // The RUN-keyed sweep must NOT touch the pipeline namespace (pretend no runs exist).
    await sweepCheckpointRefs([repo], () => false)
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/k-pipelines/']).trim()).toBe(plRefs)
    // The pipeline-keyed sweep DOES reclaim them once the pipeline_runs row is gone.
    const deleted = await sweepPipelineRefs([repo], () => false)
    expect(deleted).toBeGreaterThan(0)
    expect(git(repo, ['for-each-ref', 'refs/k-pipelines/']).trim()).toBe('')
  }, 120_000) // real git worktree ops per stage — slow on Windows
})

describe('PipelineEngine — branch→merge fan-out', () => {
  it('b) forks two siblings at the pipeline base and merges them → completed with both files', async () => {
    const spec = {
      name: 'fanout',
      stages: [
        { kind: 'deterministic', id: 'start', label: 'start', action: { type: 'command', run: WRITE('fileStart.txt') } },
        { kind: 'deterministic', id: 'a', label: 'a', action: { type: 'command', run: WRITE('fileA.txt') } },
        { kind: 'deterministic', id: 'b', label: 'b', action: { type: 'command', run: WRITE('fileB.txt') } },
        { kind: 'deterministic', id: 'join', label: 'join', action: { type: 'command', run: CHECK(['fileA.txt', 'fileB.txt']) } },
      ],
      edges: [
        { from: 'start', to: 'a', handoff: 'branch' },
        { from: 'start', to: 'b', handoff: 'branch' },
        { from: 'a', to: 'join', handoff: 'merge' },
        { from: 'b', to: 'join', handoff: 'merge' },
        { from: 'join', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'start',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'fanout demo' })
    const status = await driveToTerminal(pipelineRunId)

    expect(status).toBe('completed')
    const join = stageByKey(pipelineRunId, 'join')
    expect(join.status).toBe('passed') // join exited 0 → the fan-in merge carried BOTH files
    // The merged base join forked at carries both divergent files.
    const mergedTree = git(repo, ['ls-tree', '-r', '--name-only', join.base_commit!])
    expect(mergedTree).toContain('fileA.txt')
    expect(mergedTree).toContain('fileB.txt')
  }, 120_000) // 4 worktree stages + a fan-in merge scratch worktree
})

describe('PipelineEngine — gate park', () => {
  it('c) a gate stage parks at awaiting_gate and the pipeline stays running', async () => {
    const spec = {
      name: 'gated',
      stages: [{ kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } }],
      edges: [{ from: 'g', to: 'done', handoff: 'share-tree' }],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'gated demo' })
    await drainPipelines()

    expect(stageByKey(pipelineRunId, 'g').status).toBe('awaiting_gate')
    expect((pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status).toBe('running')
    // Retire this deliberately-parked pipeline so later drains/reconciles skip it.
    pipelineDb.updatePipelineStatus.run({ id: pipelineRunId, status: 'cancelled', updatedAt: Date.now(), completedAt: Date.now() })
  }, 30_000)

  it('fails closed when cwd is not a git repo', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-nongit-'))
    bases.push(nonGit)
    const spec = {
      name: 'x', stages: [{ kind: 'gate', id: 'g', label: 'g', gate: { mode: 'manual' } }],
      edges: [], entry: 'g',
    }
    await expect(startPipelineRun(spec, { cwd: nonGit, goal: 'g' })).rejects.toThrow(/not a git repo/)
  })
})

describe('reconcilePipelines', () => {
  it('d) fails a dispatched+null-run_id stage (never re-pending) and derives a terminal-run stage', () => {
    const now = Date.now()
    // Crafted pipeline #1: a claimed-but-never-wired ('dispatched', run_id NULL) stage.
    const plr1 = randomUUID()
    pipelineDb.insertPipelineRun.run({ id: plr1, definitionId: null, projectId: null, title: 'recon', cwd: repo, baseCommit, createdAt: now, updatedAt: now, ownerProfileId: null })
    const s1 = randomUUID()
    pipelineDb.insertStage.run({ id: s1, pipelineRunId: plr1, stageKey: 's1', kind: 'deterministic', profileId: null, spec: '{}', baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now })
    pipelineDb.claimStage.run({ id: s1, updatedAt: now, startedAt: now }) // pending→dispatched, run_id stays NULL

    // Crafted pipeline #2: a 'running' stage whose linked run is terminal 'done' → derive passed.
    const plr2 = randomUUID()
    pipelineDb.insertPipelineRun.run({ id: plr2, definitionId: null, projectId: null, title: 'recon2', cwd: repo, baseCommit, createdAt: now, updatedAt: now, ownerProfileId: null })
    const runId = randomUUID()
    runsDb.insertRun.run({ id: runId, prompt: 'p', cwd: repo, worktree: null, status: 'done', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })
    const s2 = randomUUID()
    pipelineDb.insertStage.run({ id: s2, pipelineRunId: plr2, stageKey: 's2', kind: 'agent', profileId: null, spec: '{}', baseCommit, repairStageKey: null, createdAt: now, updatedAt: now })
    pipelineDb.setStageRun.run({ id: s2, runId, baseCommit, updatedAt: now }) // → running, run_id set

    reconcilePipelines()

    expect((pipelineDb.getStage.get(s1) as PipelineStageRow).status).toBe('failed')
    expect((pipelineDb.getPipelineRun.get(plr1) as { status: string }).status).toBe('failed')
    const derived = pipelineDb.getStage.get(s2) as PipelineStageRow
    expect(derived.status).toBe('passed')
    expect(derived.result_commit).toBe(baseCommit) // no checkpoint events → falls back to the stage base
    expect((pipelineDb.getPipelineRun.get(plr2) as { status: string }).status).toBe('completed')
  })
})

describe('dispatchStage — supervised ownership stamp', () => {
  it('e) stamps runs.pipeline_stage_id and wires the stage run for a supervised stage', async () => {
    const now = Date.now()
    const plr = randomUUID()
    pipelineDb.insertPipelineRun.run({ id: plr, definitionId: null, projectId: null, title: 'sup', cwd: repo, baseCommit, createdAt: now, updatedAt: now, ownerProfileId: null })
    const stageId = randomUUID()
    pipelineDb.insertStage.run({ id: stageId, pipelineRunId: plr, stageKey: 'agent1', kind: 'agent', profileId: null, spec: '{}', baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now })
    const runId = randomUUID()
    runsDb.insertRun.run({ id: runId, prompt: 'p', cwd: repo, worktree: null, status: 'running', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })

    const stub: StageExecutor = { backend: 'worktree', dispatch: async () => ({ kind: 'supervised', runId }), cancel() { /* noop */ } }
    const run = pipelineDb.getPipelineRun.get(plr) as PipelineRunRow
    const stage = pipelineDb.getStage.get(stageId) as PipelineStageRow
    await dispatchStage(run, stage, stub)

    // The ownership back-ref is on the RUN (keyed on runs.id — never overwritten by a retry).
    expect((runsDb.getRun.get(runId) as { pipeline_stage_id?: string }).pipeline_stage_id).toBe(stageId)
    const after = pipelineDb.getStage.get(stageId) as PipelineStageRow
    expect(after.run_id).toBe(runId)
    expect(after.status).toBe('running')
    expect(after.base_commit).toBe(baseCommit)
  })
})

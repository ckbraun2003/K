/**
 * orch-p2 Lane A / Task A.2 — bounded loop finalize + readiness correctness (TOKEN-FREE).
 *
 * The single highest-stakes engine invariant of Phase 2: a `when:'loop'` edge must NEVER satisfy
 * downstream readiness or pipeline finalize (the exact class of the Phase-1 F1 false-COMPLETED
 * bug). These drive the REAL scheduler synchronously (like pipeline-engine.test.ts) against
 * isolated throwaway git repos; loop-source outcomes are steered by a counter file that lives
 * OUTSIDE the per-stage throwaway worktree, so it survives every re-fork.
 *
 *   1. loop iterates until the forward `pass` exit;
 *   2. loop respects its maxIterations cap with NO false-COMPLETED;
 *   3. a loop edge alone never marks its target ready.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { maybeFinalizePipeline } from '../src/pipeline-engine.js'
import { pipelineDb, runsDb } from '../src/db.js'
import { listLedger } from '../src/pipeline-ledger.js'
import type { PipelineStageRow } from '../src/pipeline-executor.js'

const bases: string[] = []
let repo: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A cmd.exe- AND sh-safe node -e counter step. Avoids the shell metacharacters `<`/`>`/`|`/`&`
 *  entirely (cmd.exe would treat them as redirects), so the fail/pass decision uses array
 *  membership rather than a numeric `<`. The counter file is an ABSOLUTE path outside the
 *  throwaway worktree, so it accumulates across every loop re-fork. `exitExpr` is a JS expression
 *  over `n` (the 1-based run count) yielding the process exit code. */
function counterStep(counterPath: string, exitExpr: string): string {
  const p = counterPath.replace(/\\/g, '/')
  return `node -e "const fs=require('fs'); const p='${p}'; const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1; fs.writeFileSync(p,String(n)); process.exit(${exitExpr})"`
}

function makeRepo(): { repo: string; baseCommit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-loop-'))
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

/** Counter files live under the test base dir (NOT the worktree). */
function counterPath(name: string): string {
  return path.join(bases[bases.length - 1], `${name}-count`)
}
function counterValue(name: string): number {
  const p = counterPath(name)
  return fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0
}

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

async function driveToTerminal(pipelineRunId: string, maxTicks = 24): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }
    if (run.status !== 'running') break
  }
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}

function stageByKey(pipelineRunId: string, key: string): PipelineStageRow & { iteration: number } {
  const s = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as Array<PipelineStageRow & { iteration: number }>).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}

describe('bounded loops (A.2)', () => {
  it('iterates the loop body until the forward pass exit, then COMPLETES', async () => {
    // impl always passes (and counts its runs); verify fails on runs 1 & 2, passes on run 3.
    const spec = {
      name: 'refine-loop',
      stages: [
        { kind: 'deterministic', id: 'impl', label: 'implement', action: { type: 'command', run: counterStep(counterPath('impl'), '0') } },
        { kind: 'deterministic', id: 'verify', label: 'verify', action: { type: 'command', run: counterStep(counterPath('verify'), '[1,2].includes(n)?9:0') } },
      ],
      edges: [
        { from: 'impl', to: 'verify', handoff: 'share-tree' },
        { from: 'verify', to: 'impl', handoff: 'share-tree', when: 'loop', maxIterations: 3 },
        { from: 'verify', to: 'done', handoff: 'share-tree', when: 'pass' },
      ],
      entry: 'impl',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'refine loop demo' })
    const status = await driveToTerminal(pipelineRunId)

    expect(status).toBe('completed')            // finalized via the forward pass exit
    expect(counterValue('impl')).toBe(3)         // impl ran 3×
    expect(counterValue('verify')).toBe(3)       // verify ran 3× (fail, fail, pass)
    expect(stageByKey(pipelineRunId, 'impl').iteration).toBe(2) // 0 → 1 → 2 (two loop-backs)
    expect(stageByKey(pipelineRunId, 'verify').status).toBe('passed')
    // Exactly two loop re-opens were recorded on the ledger.
    expect(listLedger(pipelineRunId).filter(e => e.kind === 'iteration')).toHaveLength(2)
  }, 240_000)

  it('respects maxIterations with NO false-COMPLETED (parks/fails at the cap)', async () => {
    // verify ALWAYS fails → the loop can never take the forward exit; the cap must stop it.
    const spec = {
      name: 'cap-loop',
      stages: [
        { kind: 'deterministic', id: 'impl', label: 'implement', action: { type: 'command', run: counterStep(counterPath('impl'), '0') } },
        { kind: 'deterministic', id: 'verify', label: 'verify', action: { type: 'command', run: counterStep(counterPath('verify'), '9') } },
      ],
      edges: [
        { from: 'impl', to: 'verify', handoff: 'share-tree' },
        { from: 'verify', to: 'impl', handoff: 'share-tree', when: 'loop', maxIterations: 3 },
        { from: 'verify', to: 'done', handoff: 'share-tree', when: 'pass' },
      ],
      entry: 'impl',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'cap loop demo' })
    const status = await driveToTerminal(pipelineRunId)

    expect(status).not.toBe('completed')         // the crux: NO false-COMPLETED
    expect(status).toBe('failed')
    expect(counterValue('impl')).toBe(3)          // impl ran exactly maxIterations times
    expect(stageByKey(pipelineRunId, 'impl').iteration).toBe(2)
    expect(stageByKey(pipelineRunId, 'verify').status).toBe('failed')
    expect(listLedger(pipelineRunId).filter(e => e.kind === 'iteration')).toHaveLength(2)
  }, 240_000)

  it('does NOT reset an in-flight loop-body sibling when the loop source fails (review I-1)', async () => {
    // The reviewer's triggering shape: impl (loop head) fans out to verify (loop source, fails fast)
    // AND slow (a parallel sibling that stays running). A premature loop re-entry — run BEFORE the
    // finalize quiescence guards — reset impl's WHOLE downstream closure (which includes `slow`) to
    // pending and NULLed slow's run_id WHILE its supervised run was still executing (orphaned run +
    // double-execution). The re-entry must not fire until the pipeline otherwise quiesces.
    const spec = {
      name: 'loop-inflight-guard',
      stages: [
        { kind: 'deterministic', id: 'impl', label: 'implement', action: { type: 'command', run: counterStep(counterPath('impl'), '0') } },
        { kind: 'deterministic', id: 'verify', label: 'verify', action: { type: 'command', run: counterStep(counterPath('verify'), '9') } },
        { kind: 'deterministic', id: 'slow', label: 'slow', action: { type: 'command', run: counterStep(counterPath('slow'), '0') } },
      ],
      edges: [
        { from: 'impl', to: 'verify', handoff: 'share-tree' },
        { from: 'impl', to: 'slow', handoff: 'share-tree' },
        { from: 'verify', to: 'impl', handoff: 'share-tree', when: 'loop', maxIterations: 3 },
        { from: 'verify', to: 'done', handoff: 'share-tree', when: 'pass' },
        { from: 'slow', to: 'done', handoff: 'share-tree', when: 'pass' },
      ],
      entry: 'impl',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'in-flight loop-body guard' })

    // Hand-set the exact mid-flight state the bug triggers on (test-3's synchronous state-set style —
    // a deterministic `slow` settles within a drain tick and can't be held 'running' via drain): the
    // loop head passed, the loop source `verify` has just settled FAILED this pass, and its parallel
    // sibling `slow` is still RUNNING under a supervised run — precisely the window a premature
    // re-entry would clobber.
    const impl = stageByKey(pipelineRunId, 'impl')
    const verify = stageByKey(pipelineRunId, 'verify')
    const slow = stageByKey(pipelineRunId, 'slow')
    const now = Date.now()
    pipelineDb.markStagePassed.run({ id: impl.id, resultCommit: baseCommit, exitCode: 0, costUsd: null, updatedAt: now, completedAt: now })
    pipelineDb.markStageFailed.run({ id: verify.id, failureClass: 'transient', exitCode: 9, costUsd: null, updatedAt: now, completedAt: now })
    const slowRunId = randomUUID()
    runsDb.insertRun.run({ id: slowRunId, prompt: 'p', cwd: repo, worktree: null, status: 'running', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })
    pipelineDb.setStageRun.run({ id: slow.id, runId: slowRunId, baseCommit, updatedAt: now }) // → status 'running', run_id set

    // The scheduler calls this at the end of the drain pass in which `verify` failed.
    maybeFinalizePipeline(pipelineRunId)

    // The in-flight sibling is UNTOUCHED: not reset to pending, run_id preserved. The loop must NOT
    // re-enter while it runs — impl.iteration unchanged, no iteration ledger entry, pipeline running.
    const slowAfter = stageByKey(pipelineRunId, 'slow')
    expect(slowAfter.status).toBe('running')
    expect(slowAfter.run_id).toBe(slowRunId)
    expect(stageByKey(pipelineRunId, 'impl').iteration).toBe(0)
    expect(listLedger(pipelineRunId).filter(e => e.kind === 'iteration')).toHaveLength(0)
    expect((pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status).toBe('running')

    pipelineDb.updatePipelineStatus.run({ id: pipelineRunId, status: 'cancelled', updatedAt: Date.now(), completedAt: Date.now() })
  }, 240_000)

  it('a loop edge alone NEVER marks its target ready', () => {
    // p → head (pass), head → mid (always), mid → head (loop), mid → done (pass).
    // With `head` NOT yet satisfied by its forward edge (p pending) but the loop source `mid`
    // passed, the loop edge must NOT make `head` ready.
    const now = Date.now()
    const pid = randomUUID()
    pipelineDb.insertPipelineRun.run({ id: pid, definitionId: null, projectId: null, title: 't', cwd: repo, baseCommit, createdAt: now, updatedAt: now })
    const ins = (key: string) => {
      const id = randomUUID()
      pipelineDb.insertStage.run({ id, pipelineRunId: pid, stageKey: key, kind: 'deterministic', profileId: null, spec: '{}', baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now })
      return id
    }
    ins('p'); ins('head'); ins('mid')
    const pass = (key: string) => {
      const row = stageByKeyRaw(pid, key)
      pipelineDb.markStagePassed.run({ id: row.id, resultCommit: baseCommit, exitCode: 0, costUsd: null, updatedAt: now, completedAt: now })
    }
    const edge = (from: string, to: string, whenCond: string) =>
      pipelineDb.insertEdge.run({ id: randomUUID(), pipelineRunId: pid, fromStageKey: from, toStageKey: to, handoff: 'share-tree', whenCond })
    edge('p', 'head', 'pass')
    edge('head', 'mid', 'always')
    edge('mid', 'head', 'loop')
    edge('mid', 'done', 'pass')

    // mid passed, p still pending → the ONLY "satisfied" incoming edge to head is the loop edge.
    pass('mid')
    let ready = (pipelineDb.listReadyStages.all({ pid }) as PipelineStageRow[]).map(s => s.stage_key)
    expect(ready).not.toContain('head') // loop edge from a passed source must NOT satisfy readiness

    // Genuinely satisfy the forward edge (p passed) → head becomes ready (readiness still works).
    pass('p')
    ready = (pipelineDb.listReadyStages.all({ pid }) as PipelineStageRow[]).map(s => s.stage_key)
    expect(ready).toContain('head')

    pipelineDb.updatePipelineStatus.run({ id: pid, status: 'cancelled', updatedAt: Date.now(), completedAt: Date.now() })
    // sanity: finalize on the (cancelled) pipeline is a no-op / never throws
    maybeFinalizePipeline(pid)
  })
})

function stageByKeyRaw(pid: string, key: string): PipelineStageRow {
  const s = (pipelineDb.listStagesForPipeline.all(pid) as PipelineStageRow[]).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}

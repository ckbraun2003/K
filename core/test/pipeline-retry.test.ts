/**
 * D-119 Lane A / wave A4 — retry-in-place + the self-heal ownership guard (TOKEN-FREE).
 *
 * Deterministic stages (real git, real child processes — no `claude`) prove the settled retry
 * ladder; a STUBBED executor proves the supervised (agent) retry re-dispatches on the fallback
 * model with retry_of lineage; a raw run row proves the global self-heal skips an engine-owned
 * run. Proves:
 *   a) a deterministic stage that fails its 1st run + passes its 2nd (retry.maxAttempts=2) →
 *      retry_count increments, the stage passes, the pipeline completes;
 *   b) a command that always fails → after the attempt budget, the stage + pipeline fail;
 *   c) the ownership guard: a run carrying runs.pipeline_stage_id is SKIPPED by onRunTerminalForHeal
 *      (autonomy + selfHeal enabled) and never retried by the global subscriber;
 *   d) handleStageFailure re-dispatches a supervised failure on the fallback model (the override
 *      reaches the executor), stamps retry_of lineage + pipeline_stage_id on the NEW run.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The deterministic paths never touch startRun; the self-heal guard test asserts it is never
// reached. Mock it so a guard regression can't spawn a real `claude` (and to assert not-called).
const { startRunMock } = vi.hoisted(() => ({ startRunMock: vi.fn() }))
vi.mock('../src/supervisor.js', async () => ({
  ...(await vi.importActual('../src/supervisor.js')), startRun: startRunMock,
}))

import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { handleStageFailure, type PipelineRunRow } from '../src/pipeline-engine.js'
import { onRunTerminalForHeal } from '../src/self-heal.js'
import { db, pipelineDb, runsDb } from '../src/db.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import type { StageExecutor, PipelineStageRow } from '../src/pipeline-executor.js'

// Autonomy ON with NO budget cap so budgetGate (checked on every retry) always has headroom.
const ON = { enabled: true, proposals: false, backlogAutoPull: false, selfHeal: true, maxConcurrency: 4, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }

const bases: string[] = []
const createdRunIds = new Set<string>()
const createdPipelineIds = new Set<string>()
let repo: string
let base: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
function trackRun(id: string): string { createdRunIds.add(id); return id }
function trackPipeline(id: string): string { createdPipelineIds.add(id); return id }

function makeRepo(): void {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-retry-'))
  bases.push(base)
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@k.local'])
  git(repo, ['config', 'user.name', 'K Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()
}

// Clear any leftover running pipelines from a sibling suite so drainPipelines only sees ours.
beforeAll(() => {
  const now = Date.now()
  for (const r of pipelineDb.listRunningPipelines.all() as Array<{ id: string }>) {
    pipelineDb.updatePipelineStatus.run({ id: r.id, status: 'cancelled', updatedAt: now, completedAt: now })
  }
})

beforeEach(() => {
  __resetConfigCache()
  setAutonomySettings(ON)
  startRunMock.mockReset()
  makeRepo()
})

afterEach(() => {
  // Our pipelines first (CASCADE drops stages/edges → no stage.run_id ref survives), then our
  // runs leaf-first (runs.retry_of is a RESTRICT self-FK, so a retry must go before its parent).
  for (const plr of createdPipelineIds) { try { db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(plr) } catch { /* ignore */ } }
  createdPipelineIds.clear()
  for (const id of createdRunIds) {
    try { db.prepare(`DELETE FROM events WHERE run_id = ?`).run(id) } catch { /* ignore */ }
    try { db.prepare(`DELETE FROM agent_runs WHERE run_id = ?`).run(id) } catch { /* ignore */ }
  }
  let removed: number
  do {
    removed = 0
    for (const id of [...createdRunIds]) {
      if (db.prepare(`SELECT 1 FROM runs WHERE retry_of = ? LIMIT 1`).get(id)) continue
      try { db.prepare(`DELETE FROM runs WHERE id = ?`).run(id); createdRunIds.delete(id); removed++ } catch { /* ignore */ }
    }
  } while (removed > 0)
  createdRunIds.clear()
  for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

/** Drive the scheduler until the pipeline leaves 'running' (bounded). */
async function driveToTerminal(pipelineRunId: string, maxTicks = 15): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    if ((pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status !== 'running') break
  }
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}

function stageByKey(pipelineRunId: string, key: string): PipelineStageRow {
  const s = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}

describe('pipeline retry — deterministic settled ladder', () => {
  it('a) retries a flaky command (fail→pass), increments retry_count, completes', async () => {
    // A counter file OUTSIDE the (fresh-per-dispatch) worktree: exit 1 the first time, 0 after.
    const counter = path.join(base, 'counter.txt').replace(/\\/g, '/')
    const FAIL_THEN_PASS = `node -e "const fs=require('fs');const c='${counter}';if(fs.existsSync(c)){process.exit(0)}else{fs.writeFileSync(c,'1');process.exit(1)}"`
    const spec = {
      name: 'flaky',
      stages: [{ kind: 'deterministic', id: 'det', label: 'flaky', action: { type: 'command', run: FAIL_THEN_PASS }, retry: { maxAttempts: 2 } }],
      edges: [{ from: 'det', to: 'done', handoff: 'share-tree' }],
      entry: 'det',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'flaky demo' })
    trackPipeline(pipelineRunId)
    const status = await driveToTerminal(pipelineRunId)

    expect(status).toBe('completed')
    const det = stageByKey(pipelineRunId, 'det')
    expect(det.status).toBe('passed') // it SAW the counter on the retry → exit 0
    expect(det.retry_count).toBe(1)   // 1 retry consumed (attempt 2 of maxAttempts=2)
  }, 120_000)

  it('b) fails the stage + pipeline once the attempt budget is spent', async () => {
    const spec = {
      name: 'doomed',
      stages: [{ kind: 'deterministic', id: 'det', label: 'doomed', action: { type: 'command', run: `node -e "process.exit(1)"` }, retry: { maxAttempts: 2 } }],
      edges: [{ from: 'det', to: 'done', handoff: 'share-tree' }],
      entry: 'det',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'doomed demo' })
    trackPipeline(pipelineRunId)
    const status = await driveToTerminal(pipelineRunId)

    expect(status).toBe('failed')
    const det = stageByKey(pipelineRunId, 'det')
    expect(det.status).toBe('failed')
    // maxAttempts=2 = 2 TOTAL attempts (original + 1 retry); the default (1) would never retry.
    expect(det.retry_count).toBe(1)
  }, 120_000)
})

describe('self-heal ownership guard (§10)', () => {
  it('c) skips a run carrying runs.pipeline_stage_id and never retries it', async () => {
    const now = Date.now()
    // A parent so the guarded run is a genuine descended retry (eligible via retry_of) — the
    // ONLY thing making it skip is the pipeline_stage_id back-ref, not a missing owner.
    const parentId = trackRun(randomUUID())
    runsDb.insertRun.run({ id: parentId, prompt: 'p', cwd: '.', worktree: null, status: 'error', provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })
    const guardedId = trackRun(randomUUID())
    runsDb.insertRun.run({ id: guardedId, prompt: 'p', cwd: '.', worktree: null, status: 'error', provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })
    // Engine-owned (pipeline_stage_id set) + retryable-but-for-the-guard (retry_of + a transient stderr).
    db.prepare(`UPDATE runs SET retry_of = ?, retry_count = 1, pipeline_stage_id = ? WHERE id = ?`).run(parentId, 'stage-guarded', guardedId)
    db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'error', ?, 'ECONNRESET')`).run('e-' + guardedId, guardedId, now)

    expect(await onRunTerminalForHeal({ id: guardedId, status: 'error' } as never)).toBe('skipped')
    expect(startRunMock).not.toHaveBeenCalled()
  })
})

describe('handleStageFailure — supervised retry on the fallback model', () => {
  it('d) re-dispatches with the fallback model + stamps retry_of + pipeline_stage_id on the new run', async () => {
    const now = Date.now()
    const plr = trackPipeline(randomUUID())
    pipelineDb.insertPipelineRun.run({ id: plr, definitionId: null, projectId: null, title: 'sup retry', cwd: repo, baseCommit, createdAt: now, updatedAt: now })
    const stageId = randomUUID()
    // spec carries only the retry policy — the stub executor ignores the rest.
    pipelineDb.insertStage.run({ id: stageId, pipelineRunId: plr, stageKey: 'agent1', kind: 'agent', profileId: null, spec: JSON.stringify({ retry: { maxAttempts: 2 } }), baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now })

    // The failed ORIGINAL run: opus + a capacity error → fallbackModel downgrades to sonnet.
    const oldRunId = trackRun(randomUUID())
    runsDb.insertRun.run({ id: oldRunId, prompt: 'p', cwd: repo, worktree: null, status: 'error', provider: 'claude', model: 'claude-opus-4-8', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })
    db.prepare(`UPDATE runs SET pipeline_stage_id = ? WHERE id = ?`).run(stageId, oldRunId) // engine stamped it at first dispatch
    db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'error', ?, 'overloaded_error 529')`).run('e-' + oldRunId, oldRunId, now)
    pipelineDb.setStageRun.run({ id: stageId, runId: oldRunId, baseCommit, updatedAt: now }) // → running, run_id = old

    // The retry's run row (the stub hands back this id as the new supervised run).
    const newRunId = trackRun(randomUUID())
    runsDb.insertRun.run({ id: newRunId, prompt: 'p', cwd: repo, worktree: null, status: 'running', provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: now })

    let seenModelOverride: string | undefined = 'UNSET'
    const stub: StageExecutor = {
      backend: 'worktree',
      dispatch: async ctx => { seenModelOverride = ctx.modelOverride; return { kind: 'supervised', runId: newRunId } },
      cancel() { /* noop */ },
    }

    const run = pipelineDb.getPipelineRun.get(plr) as PipelineRunRow
    const stage = pipelineDb.getStage.get(stageId) as PipelineStageRow
    await handleStageFailure(run, stage, { supervised: true }, stub)

    expect(seenModelOverride).toBe('claude-sonnet-4-6') // the classifier's fallback reached the executor
    const newRun = runsDb.getRun.get(newRunId) as { retry_of?: string; retry_count?: number; pipeline_stage_id?: string }
    expect(newRun.retry_of).toBe(oldRunId)
    expect(newRun.retry_count).toBe(1)
    expect(newRun.pipeline_stage_id).toBe(stageId) // stamped on the NEW run (the ownership back-ref)
    const after = pipelineDb.getStage.get(stageId) as PipelineStageRow
    expect(after.run_id).toBe(newRunId)
    expect(after.status).toBe('running')
    expect(after.retry_count).toBe(1)
  })
})

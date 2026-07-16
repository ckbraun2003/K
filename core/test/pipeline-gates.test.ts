/**
 * D-119 Lane A / wave A5 — gates + conditional FORWARD routing + skip propagation (TOKEN-FREE).
 *
 * Deterministic + gate stages only (no `claude` ever spawns). Real git against isolated throwaway
 * repos; the shared vitest DB carries the pipeline ledger (unique UUIDs per test). Proves:
 *   a) gate APPROVE — det(A)→gate→det(B,pass): A passes, the gate parks awaiting_gate while the
 *      pipeline stays running; resolveGate(approve) → B runs (the handoff carries THROUGH the
 *      gate) → completed;
 *   b) gate REJECT with a fail-branch — gate→{pass→B, fail→C}: reject fail-activates C, B is
 *      skipped, the pipeline completes (the gate failed but its failure was routed);
 *   c) gate REJECT with NO fail-branch — reject skips B and the gate is an unhandled dead-end →
 *      the pipeline fails;
 *   d) skip propagation — an untaken fail-branch with a 2-stage tail is FULLY skipped (fixpoint);
 *   e) skip-aware finalize — a completed pass-path with a permanently-untaken fail-branch
 *      finalizes completed, NOT failed (the A3 stranded-pending misfire, fixed);
 *   f) resolveGate CAS — a second resolve of an already-resolved gate returns false;
 *   g) insertGate — a runtime gate before a pending stage makes it wait; resolve → it proceeds;
 *      inserting before a non-pending stage throws a PipelineConflictError.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { resolveGate, insertGate, PipelineConflictError } from '../src/pipeline-engine.js'
import { db, pipelineDb } from '../src/db.js'
import type { PipelineStageRow } from '../src/pipeline-executor.js'

const bases: string[] = []
const createdPipelineIds = new Set<string>()
let repo: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Cross-platform (cmd.exe + sh) children. The throwaway worktree has no package.json, so
 *  `node -e` runs CommonJS (require resolves). */
const WRITE = (f: string) => `node -e "require('fs').writeFileSync('${f}','x')"`
const CHECK_THEN_WRITE = (need: string[], write: string) =>
  `node -e "const fs=require('fs'); if(${need.map(f => `!fs.existsSync('${f}')`).join('||')}) process.exit(9); fs.writeFileSync('${write}','x')"`

function makeRepo(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-gates-'))
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
  return r
}

// Clear any leftover running pipelines from a sibling suite so drainPipelines only sees ours.
beforeAll(() => {
  const now = Date.now()
  for (const r of pipelineDb.listRunningPipelines.all() as Array<{ id: string }>) {
    pipelineDb.updatePipelineStatus.run({ id: r.id, status: 'cancelled', updatedAt: now, completedAt: now })
  }
})

beforeEach(() => {
  repo = makeRepo()
})

afterEach(() => {
  // Drop our pipelines (CASCADE clears their stages/edges) so no parked gate leaks into a sibling
  // suite's drain, then remove the throwaway repos.
  for (const plr of createdPipelineIds) { try { db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(plr) } catch { /* ignore */ } }
  createdPipelineIds.clear()
  for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

function track(id: string): string { createdPipelineIds.add(id); return id }

function stageByKey(pipelineRunId: string, key: string): PipelineStageRow {
  const s = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}
function statusOf(pipelineRunId: string): string {
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}

/** Drive the scheduler until the pipeline leaves 'running' (bounded). */
async function driveToTerminal(pipelineRunId: string, maxTicks = 15): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    if (statusOf(pipelineRunId) !== 'running') break
  }
  return statusOf(pipelineRunId)
}

/** Drive until a stage (by key) reaches `status` (bounded). Used to catch a parked gate. */
async function driveUntilStageStatus(pipelineRunId: string, key: string, status: string, maxTicks = 12): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    if (stageByKey(pipelineRunId, key).status === status) return
  }
  throw new Error(`stage '${key}' never reached '${status}'`)
}

describe('pipeline gates — APPROVE', () => {
  it('a) gate parks, pipeline stays running, resolveGate(approve) proceeds the pass-branch', async () => {
    const spec = {
      name: 'gate-approve',
      stages: [
        { kind: 'deterministic', id: 'a', label: 'write A', action: { type: 'command', run: WRITE('fileA.txt') } },
        { kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } },
        { kind: 'deterministic', id: 'b', label: 'see A, write B', action: { type: 'command', run: CHECK_THEN_WRITE(['fileA.txt'], 'fileB.txt') } },
      ],
      edges: [
        { from: 'a', to: 'g', handoff: 'share-tree' },
        { from: 'g', to: 'b', handoff: 'share-tree', when: 'pass' },
        { from: 'b', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'a',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'approve demo' })
    track(pipelineRunId)

    await driveUntilStageStatus(pipelineRunId, 'g', 'awaiting_gate')
    expect(stageByKey(pipelineRunId, 'a').status).toBe('passed')
    expect(statusOf(pipelineRunId)).toBe('running')            // a parked gate keeps it running
    expect(stageByKey(pipelineRunId, 'b').status).toBe('pending') // b waits behind the gate

    const g = stageByKey(pipelineRunId, 'g')
    expect(resolveGate(g.id, 'approve', 'tester', 'looks good')).toBe(true)

    const status = await driveToTerminal(pipelineRunId)
    expect(status).toBe('completed')
    const resolved = stageByKey(pipelineRunId, 'g')
    expect(resolved.status).toBe('passed')
    expect(resolved.gate_resolved_by).toBe('tester')
    expect(resolved.gate_note).toBe('looks good')
    expect(stageByKey(pipelineRunId, 'b').status).toBe('passed') // b SAW fileA — the handoff carried through the gate
  }, 60_000)
})

describe('pipeline gates — REJECT', () => {
  it('b) reject with a fail-branch fail-activates C, skips B, and the pipeline completes', async () => {
    const spec = {
      name: 'gate-reject-routed',
      stages: [
        { kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } },
        { kind: 'deterministic', id: 'b', label: 'pass branch', action: { type: 'command', run: WRITE('fileB.txt') } },
        { kind: 'deterministic', id: 'c', label: 'fail branch', action: { type: 'command', run: WRITE('fileC.txt') } },
      ],
      edges: [
        { from: 'g', to: 'b', handoff: 'share-tree', when: 'pass' },
        { from: 'g', to: 'c', handoff: 'share-tree', when: 'fail' },
        { from: 'b', to: 'done', handoff: 'share-tree' },
        { from: 'c', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'reject-routed demo' })
    track(pipelineRunId)

    await driveUntilStageStatus(pipelineRunId, 'g', 'awaiting_gate')
    expect(resolveGate(stageByKey(pipelineRunId, 'g').id, 'reject', 'tester')).toBe(true)

    const status = await driveToTerminal(pipelineRunId)
    expect(status).toBe('completed')                              // the gate failed, but the failure was ROUTED
    expect(stageByKey(pipelineRunId, 'g').status).toBe('failed')
    expect(stageByKey(pipelineRunId, 'c').status).toBe('passed')  // fail-activated
    expect(stageByKey(pipelineRunId, 'b').status).toBe('skipped') // pass-branch untaken
  }, 60_000)

  it('c) reject with NO fail-branch skips B and fails the pipeline (unhandled dead-end)', async () => {
    const spec = {
      name: 'gate-reject-dead',
      stages: [
        { kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } },
        { kind: 'deterministic', id: 'b', label: 'pass branch', action: { type: 'command', run: WRITE('fileB.txt') } },
      ],
      edges: [
        { from: 'g', to: 'b', handoff: 'share-tree', when: 'pass' },
        { from: 'b', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'reject-dead demo' })
    track(pipelineRunId)

    await driveUntilStageStatus(pipelineRunId, 'g', 'awaiting_gate')
    expect(resolveGate(stageByKey(pipelineRunId, 'g').id, 'reject', 'tester')).toBe(true)

    const status = await driveToTerminal(pipelineRunId)
    expect(status).toBe('failed')                                 // gate failed + no fail out-edge = unhandled
    expect(stageByKey(pipelineRunId, 'g').status).toBe('failed')
    expect(stageByKey(pipelineRunId, 'b').status).toBe('skipped')
  }, 60_000)
})

describe('pipeline gates — skip propagation', () => {
  it('d) an untaken fail-branch with a 2-stage tail is fully skipped', async () => {
    const spec = {
      name: 'skip-tail',
      stages: [
        { kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } },
        { kind: 'deterministic', id: 'pass1', label: 'pass', action: { type: 'command', run: WRITE('filePass.txt') } },
        { kind: 'deterministic', id: 'fail1', label: 'fail head', action: { type: 'command', run: WRITE('fileF1.txt') } },
        { kind: 'deterministic', id: 'fail2', label: 'fail tail', action: { type: 'command', run: WRITE('fileF2.txt') } },
      ],
      edges: [
        { from: 'g', to: 'pass1', handoff: 'share-tree', when: 'pass' },
        { from: 'g', to: 'fail1', handoff: 'share-tree', when: 'fail' },
        { from: 'fail1', to: 'fail2', handoff: 'share-tree' },
        { from: 'pass1', to: 'done', handoff: 'share-tree' },
        { from: 'fail2', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'skip-tail demo' })
    track(pipelineRunId)

    await driveUntilStageStatus(pipelineRunId, 'g', 'awaiting_gate')
    expect(resolveGate(stageByKey(pipelineRunId, 'g').id, 'approve', 'tester')).toBe(true)

    const status = await driveToTerminal(pipelineRunId)
    expect(status).toBe('completed')
    expect(stageByKey(pipelineRunId, 'pass1').status).toBe('passed')
    expect(stageByKey(pipelineRunId, 'fail1').status).toBe('skipped') // untaken fail head
    expect(stageByKey(pipelineRunId, 'fail2').status).toBe('skipped') // skip propagated to the tail
  }, 60_000)

  it('e) skip-aware finalize: a completed pass-path with a permanently-untaken fail-branch completes', async () => {
    // The A3 misfire case: A passes → B (pass) runs; C (fail) is never taken. A3 left C `pending`
    // and mis-failed the pipeline. markSkips now skips C so finalize reads `completed`.
    const spec = {
      name: 'a3-misfire',
      stages: [
        { kind: 'deterministic', id: 'a', label: 'A', action: { type: 'command', run: WRITE('fileA.txt') } },
        { kind: 'deterministic', id: 'b', label: 'B', action: { type: 'command', run: WRITE('fileB.txt') } },
        { kind: 'deterministic', id: 'c', label: 'C repair', action: { type: 'command', run: WRITE('fileC.txt') } },
      ],
      edges: [
        { from: 'a', to: 'b', handoff: 'share-tree', when: 'pass' },
        { from: 'a', to: 'c', handoff: 'share-tree', when: 'fail' },
        { from: 'b', to: 'done', handoff: 'share-tree' },
        { from: 'c', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'a',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'a3-misfire demo' })
    track(pipelineRunId)

    const status = await driveToTerminal(pipelineRunId)
    expect(status).toBe('completed') // NOT failed — the untaken fail-branch is skipped, not stranded
    expect(stageByKey(pipelineRunId, 'a').status).toBe('passed')
    expect(stageByKey(pipelineRunId, 'b').status).toBe('passed')
    expect(stageByKey(pipelineRunId, 'c').status).toBe('skipped')
  }, 60_000)
})

describe('pipeline gates — CAS conflict + dynamic insert', () => {
  it('f) a second resolve of an already-resolved gate returns false', async () => {
    const spec = {
      name: 'gate-cas',
      stages: [{ kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } }],
      edges: [{ from: 'g', to: 'done', handoff: 'share-tree', when: 'pass' }],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'cas demo' })
    track(pipelineRunId)

    await driveUntilStageStatus(pipelineRunId, 'g', 'awaiting_gate')
    const gateId = stageByKey(pipelineRunId, 'g').id
    expect(resolveGate(gateId, 'approve', 'first')).toBe(true)   // wins the CAS
    expect(resolveGate(gateId, 'reject', 'second')).toBe(false)  // already resolved → lost the CAS
    // The first resolver's decision stands.
    expect(stageByKey(pipelineRunId, 'g').status).toBe('passed')
    expect(stageByKey(pipelineRunId, 'g').gate_resolved_by).toBe('first')
    expect(await driveToTerminal(pipelineRunId)).toBe('completed')
  }, 60_000)

  it('g) insertGate before a pending stage makes it wait; resolve proceeds; before a non-pending stage throws', async () => {
    const spec = {
      name: 'dynamic-gate',
      stages: [
        { kind: 'deterministic', id: 'a', label: 'write A', action: { type: 'command', run: WRITE('fileA.txt') } },
        { kind: 'deterministic', id: 'b', label: 'see A, write B', action: { type: 'command', run: CHECK_THEN_WRITE(['fileA.txt'], 'fileB.txt') } },
      ],
      edges: [
        { from: 'a', to: 'b', handoff: 'share-tree' },
        { from: 'b', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'a',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'dynamic-gate demo' })
    track(pipelineRunId)

    // Insert a gate immediately before B while both stages are still pending.
    const gateId = insertGate(pipelineRunId, 'b', { by: 'tester', label: 'review before B' })
    const gateKey = (pipelineDb.getStage.get(gateId) as PipelineStageRow).stage_key

    await driveUntilStageStatus(pipelineRunId, gateKey, 'awaiting_gate')
    expect(stageByKey(pipelineRunId, 'a').status).toBe('passed')
    expect(stageByKey(pipelineRunId, 'b').status).toBe('pending') // B now waits behind the inserted gate
    expect(statusOf(pipelineRunId)).toBe('running')

    expect(resolveGate(gateId, 'approve', 'tester')).toBe(true)
    expect(await driveToTerminal(pipelineRunId)).toBe('completed')
    expect(stageByKey(pipelineRunId, 'b').status).toBe('passed')  // B still saw fileA THROUGH the inserted gate

    // Inserting a gate before an already-resolved (non-pending) stage is a conflict.
    expect(() => insertGate(pipelineRunId, 'a', { by: 'tester' })).toThrow(PipelineConflictError)
  }, 60_000)
})

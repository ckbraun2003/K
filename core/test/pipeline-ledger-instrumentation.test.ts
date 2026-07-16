/**
 * orch-p2 Lane A / Task A.3 — engine ledger instrumentation (TOKEN-FREE).
 *
 * The engine writes a PipelineLedgerEntry at every meaningful transition (dispatch, terminal,
 * artifact handoff, gate park/resolve, pipeline terminal) so a run can be RECONSTRUCTED from its
 * ledger alone. Drives the real scheduler synchronously against isolated throwaway git repos.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelines } from '../src/pipeline-scheduler.js'
import { resolveGate } from '../src/pipeline-engine.js'
import { pipelineDb } from '../src/db.js'
import { listLedger } from '../src/pipeline-ledger.js'
import type { PipelineStageRow } from '../src/pipeline-executor.js'

const bases: string[] = []
let repo: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
const WRITE = (f: string) => `node -e "require('fs').writeFileSync('${f}','x')"`

function makeRepo(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-ledg-'))
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

beforeAll(() => {
  const now = Date.now()
  for (const r of pipelineDb.listRunningPipelines.all() as Array<{ id: string }>) {
    pipelineDb.updatePipelineStatus.run({ id: r.id, status: 'cancelled', updatedAt: now, completedAt: now })
  }
})
beforeEach(() => { repo = makeRepo() })
afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

async function driveToTerminal(pipelineRunId: string, maxTicks = 20): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    await drainPipelines()
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }
    if (run.status !== 'running') break
  }
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}

describe('engine ledger instrumentation (A.3)', () => {
  it('reconstructs a 3-stage run from its ledger (dispatch + terminal + pipeline terminal)', async () => {
    const spec = {
      name: 'three',
      stages: [
        { kind: 'deterministic', id: 'det1', label: 's1', action: { type: 'command', run: WRITE('f1.txt') } },
        { kind: 'deterministic', id: 'det2', label: 's2', action: { type: 'command', run: WRITE('f2.txt') } },
        { kind: 'deterministic', id: 'det3', label: 's3', action: { type: 'command', run: WRITE('f3.txt') } },
      ],
      edges: [
        { from: 'det1', to: 'det2', handoff: 'share-tree' },
        { from: 'det2', to: 'det3', handoff: 'share-tree' },
        { from: 'det3', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'det1',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'ledger demo' })
    expect(await driveToTerminal(pipelineRunId)).toBe('completed')

    const led = listLedger(pipelineRunId)
    // Every stage recorded a dispatch AND a passed terminal transition.
    for (const key of ['det1', 'det2', 'det3']) {
      const forStage = led.filter(e => e.stageKey === key)
      expect(forStage.some(e => e.kind === 'transition' && (e.detail as { event?: string })?.event === 'dispatch')).toBe(true)
      expect(forStage.some(e => e.kind === 'transition' && (e.detail as { event?: string; status?: string })?.status === 'passed')).toBe(true)
    }
    // A run-level pipeline-terminal entry marks completion.
    const terminal = led.filter(e => e.stageKey === null && (e.detail as { event?: string })?.event === 'pipeline')
    expect(terminal).toHaveLength(1)
    expect((terminal[0].detail as { status?: string }).status).toBe('completed')

    // RECONSTRUCT: the passed stage order derived purely from ledger terminal entries.
    const passedOrder = led
      .filter(e => e.stageKey != null && (e.detail as { status?: string })?.status === 'passed')
      .map(e => e.stageKey)
    expect(passedOrder).toEqual(['det1', 'det2', 'det3'])

    // seq is a dense monotonic 1..N cursor.
    expect(led.map(e => e.seq)).toEqual(led.map((_, i) => i + 1))
  }, 180_000)

  it('records gate park + resolve as kind:gate entries', async () => {
    const spec = {
      name: 'gated',
      stages: [
        { kind: 'gate', id: 'g', label: 'approve', gate: { mode: 'manual' } },
        { kind: 'deterministic', id: 'after', label: 'after', action: { type: 'command', run: WRITE('after.txt') } },
      ],
      edges: [
        { from: 'g', to: 'after', handoff: 'share-tree', when: 'pass' },
        { from: 'after', to: 'done', handoff: 'share-tree' },
      ],
      entry: 'g',
    }
    const { pipelineRunId } = await startPipelineRun(spec, { cwd: repo, goal: 'gate demo' })
    await drainPipelines() // g parks
    const g = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]).find(s => s.stage_key === 'g')!
    expect(g.status).toBe('awaiting_gate')
    expect(resolveGate(g.id, 'approve', 'operator')).toBe(true)
    expect(await driveToTerminal(pipelineRunId)).toBe('completed')

    const gateEntries = listLedger(pipelineRunId).filter(e => e.kind === 'gate' && e.stageKey === 'g')
    // one park, one resolve
    expect(gateEntries.some(e => (e.detail as { event?: string })?.event === 'park')).toBe(true)
    expect(gateEntries.some(e => (e.detail as { event?: string; decision?: string })?.decision === 'approve')).toBe(true)
  }, 180_000)
})

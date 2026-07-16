/**
 * D-119 Lane B / wave B1 — the 3 executable reference pipelines + seed + rowToPipelineSpec
 * (TOKEN-FREE). No `claude` ever spawns: the DAG-shape test drives the engine with a STUB
 * StageExecutor (agent + deterministic stages settle passed; the gate parks), so the reference
 * code-wave DAG is proven well-formed WITHOUT any real dispatch. Real git only for the fan-in
 * merge the engine computes (isolated throwaway repo). Proves:
 *   a) all 3 seeded specs PipelineSpecSchema.safeParse success — and none use the deferred
 *      commit/ci actions or a repair back-edge (the Phase-1 as-built constraints);
 *   b) seedPipelineSpecs() is idempotent — one row per seed, spec byte-stable across a re-seed;
 *   c) rowToPipelineSpec — a seeded row's spec parses; a legacy (null-spec) row compiles to the
 *      single-orchestrator lift (namedWorkflowToPipeline);
 *   d) the code-wave DAG runs to `completed` under the stub, and the parallel branch reviews both
 *      ran BEFORE the merge-join controller (the fan-out→fan-in join is well-formed).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PipelineSpecSchema } from '@k/shared'
import { CODE_WAVE_SPEC, INVESTIGATE_SPEC, REFACTOR_SPEC, seedPipelineSpecs } from '../src/pipeline-seeds.js'
import { instantiatePipeline, rowToPipelineSpec } from '../src/pipeline-defs.js'
import { dispatchStage, markSkips, maybeFinalizePipeline, resolveGate, type PipelineRunRow } from '../src/pipeline-engine.js'
import { db, pipelineDb, workflowDefsDb } from '../src/db.js'
import type { StageExecutor, PipelineStageRow } from '../src/pipeline-executor.js'

const ALL_SPECS = { 'Code wave': CODE_WAVE_SPEC, Investigate: INVESTIGATE_SPEC, Refactor: REFACTOR_SPEC }

const bases: string[] = []
const createdPipelineIds = new Set<string>()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-seeds-'))
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

// Clear any leftover running pipelines from a sibling suite so a stray drive can't touch them.
beforeAll(() => {
  const now = Date.now()
  for (const r of pipelineDb.listRunningPipelines.all() as Array<{ id: string }>) {
    pipelineDb.updatePipelineStatus.run({ id: r.id, status: 'cancelled', updatedAt: now, completedAt: now })
  }
})

afterEach(() => {
  for (const plr of createdPipelineIds) { try { db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(plr) } catch { /* ignore */ } }
  createdPipelineIds.clear()
  for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

function track(id: string): string { createdPipelineIds.add(id); return id }
function statusOf(pipelineRunId: string): string {
  return (pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status
}
function stagesOf(pipelineRunId: string): PipelineStageRow[] {
  return pipelineDb.listStagesForPipeline.all(pipelineRunId) as PipelineStageRow[]
}
function stageByKey(pipelineRunId: string, key: string): PipelineStageRow {
  const s = stagesOf(pipelineRunId).find(x => x.stage_key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}

describe('B1 — reference specs are valid + Phase-1-safe', () => {
  it('a) all 3 seeded specs pass PipelineSpecSchema.safeParse', () => {
    for (const spec of Object.values(ALL_SPECS)) {
      expect(PipelineSpecSchema.safeParse(spec).success).toBe(true)
    }
  })

  it('a2) none use the deferred commit/ci actions or a repair back-edge', () => {
    for (const spec of Object.values(ALL_SPECS)) {
      for (const stage of spec.stages) {
        expect(stage.repair).toBeUndefined() // repair-LOOP routing is deferred
        if (stage.kind === 'deterministic') {
          expect(['verify', 'command']).toContain(stage.action.type) // NOT commit/ci (settle failed)
        }
      }
      for (const edge of spec.edges) {
        expect(edge.when).not.toBe('repair') // no repair back-edge
        expect(edge.from).not.toBe(edge.to) // no self-loop
      }
    }
  })

  it('a3) code-wave is the reference fan-out→fan-in shape', () => {
    expect(CODE_WAVE_SPEC.entry).toBe('implementer')
    expect(CODE_WAVE_SPEC.stages.map(s => s.id)).toEqual(
      ['implementer', 'spec-review', 'quality-review', 'controller', 'gate-reviews', 'verify'],
    )
    // implementer fans out to BOTH reviews via share-tree (each reviewer inherits the
    // implementer's tree — a code reviewer must see the changes); both reviews merge into the
    // controller (fan-in join).
    const fanOut = CODE_WAVE_SPEC.edges.filter(e => e.from === 'implementer')
    expect(fanOut.map(e => e.to).sort()).toEqual(['quality-review', 'spec-review'])
    expect(fanOut.every(e => e.handoff === 'share-tree')).toBe(true)
    const mergeSources = CODE_WAVE_SPEC.edges.filter(e => e.to === 'controller' && e.handoff === 'merge').map(e => e.from)
    expect(mergeSources.sort()).toEqual(['quality-review', 'spec-review'])
  })
})

describe('B1 — seedPipelineSpecs', () => {
  it('b) idempotent — one workflow_definitions row per seed, spec byte-stable across a re-seed', () => {
    // Start from a clean seed: the shared test DB may hold a spec an EARLIER code version seeded
    // (seedPipelineSpecs writes only-when-NULL, so it never rewrites a stale one). Clearing the
    // rows makes the stored spec reflect the CURRENT CODE_WAVE_SPEC for the round-trip assertion.
    db.prepare(`DELETE FROM workflow_definitions WHERE id IN ('code-wave','investigate','refactor')`).run()
    seedPipelineSpecs()
    const countBefore = (db.prepare(
      `SELECT COUNT(*) AS n FROM workflow_definitions WHERE id IN ('code-wave','investigate','refactor')`,
    ).get() as { n: number }).n
    const firstSpec = (pipelineDb.getDefSpec.get('code-wave') as { spec: string }).spec

    seedPipelineSpecs() // second pass must not duplicate rows or rewrite the spec

    const countAfter = (db.prepare(
      `SELECT COUNT(*) AS n FROM workflow_definitions WHERE id IN ('code-wave','investigate','refactor')`,
    ).get() as { n: number }).n
    const secondSpec = (pipelineDb.getDefSpec.get('code-wave') as { spec: string }).spec

    expect(countBefore).toBe(3)
    expect(countAfter).toBe(3)
    expect(secondSpec).toBe(firstSpec) // stable — an operator-edited spec would survive too
    // The stored spec round-trips back to the authored CODE_WAVE_SPEC.
    expect(rowToPipelineSpec(workflowDefsDb.getWorkflowDefRow.get('code-wave') as Record<string, unknown>)).toEqual(CODE_WAVE_SPEC)
  })
})

describe('B1 — rowToPipelineSpec', () => {
  it('c) a seeded row parses; a legacy null-spec row compiles to the single-orchestrator lift', () => {
    seedPipelineSpecs()
    // Seeded (spec present) → parsed executable spec.
    const seededRow = workflowDefsDb.getWorkflowDefRow.get('investigate') as Record<string, unknown>
    const parsed = rowToPipelineSpec(seededRow)
    expect(parsed.name).toBe('Investigate')
    expect(parsed.stages.map(s => s.id)).toEqual(['investigator', 'synthesizer'])

    // Legacy (spec NULL) → lazy compile of the NamedWorkflow into ONE orchestrator stage.
    const legacyId = 'legacy-' + randomUUID()
    workflowDefsDb.insertWorkflowDef.run({
      id: legacyId, name: 'Legacy ' + legacyId, roles: JSON.stringify([]),
      promptScaffold: 'Do the legacy thing.', crossProject: 0, createdAt: Date.now(),
    })
    const legacyRow = workflowDefsDb.getWorkflowDefRow.get(legacyId) as Record<string, unknown>
    expect(legacyRow.spec).toBeNull() // insert leaves spec unset
    const compiled = rowToPipelineSpec(legacyRow)
    expect(compiled.stages).toHaveLength(1)
    expect(compiled.stages[0].kind).toBe('agent')
    expect(compiled.stages[0].id).toBe('orchestrator')
    expect(compiled.entry).toBe('orchestrator')
    expect(compiled.edges).toEqual([])
  })
})

describe('B1 — code-wave DAG shape (stub executor, no dispatch)', () => {
  let repo: string
  beforeEach(() => { repo = makeRepo() })

  // The dispatch order the stub observed — proves the parallel reviews preceded the merge join.
  const dispatchOrder: string[] = []
  const stub: StageExecutor = {
    backend: 'worktree',
    dispatch: async (ctx) => {
      dispatchOrder.push(ctx.stage.stage_key)
      // Gate parks (the engine's resolveGate advances it); everything else settles passed at its
      // fork base (so the controller's fan-in merge of two identical review trees is a no-op).
      return ctx.stage.kind === 'gate'
        ? { kind: 'parked', status: 'awaiting_gate' }
        : { kind: 'settled', status: 'passed', resultCommit: ctx.baseCommit ?? undefined }
    },
    cancel() { /* noop */ },
  }

  /** One scheduler-style tick SCOPED to a single pipeline, injecting the stub via the
   *  dispatchStage executor seam (mirrors pipeline-engine.test.ts test-e). */
  async function drainWith(pipelineRunId: string): Promise<void> {
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow | undefined
    if (!run || run.status !== 'running') return
    markSkips(run.id)
    for (const stage of pipelineDb.listReadyStages.all({ pid: run.id }) as PipelineStageRow[]) {
      const now = Date.now()
      if (pipelineDb.claimStage.run({ id: stage.id, updatedAt: now, startedAt: now }).changes === 0) continue
      await dispatchStage(run, stage, stub)
    }
    maybeFinalizePipeline(run.id)
  }

  it('d) drives to completed; both branch reviews ran before the merge-join controller', async () => {
    dispatchOrder.length = 0
    const pipelineRunId = track(instantiatePipeline(CODE_WAVE_SPEC, { cwd: repo, goal: 'stub demo' }))

    for (let i = 0; i < 25 && statusOf(pipelineRunId) === 'running'; i++) {
      await drainWith(pipelineRunId)
      const gate = stagesOf(pipelineRunId).find(s => s.kind === 'gate')
      if (gate && gate.status === 'awaiting_gate') resolveGate(gate.id, 'approve', 'tester')
    }

    expect(statusOf(pipelineRunId)).toBe('completed')
    for (const key of ['implementer', 'spec-review', 'quality-review', 'controller', 'gate-reviews', 'verify']) {
      expect(stageByKey(pipelineRunId, key).status).toBe('passed')
    }
    // The merge join: the controller was dispatched only AFTER both parallel reviews ran.
    const ctrlIdx = dispatchOrder.indexOf('controller')
    expect(ctrlIdx).toBeGreaterThan(0)
    expect(dispatchOrder.indexOf('spec-review')).toBeGreaterThanOrEqual(0)
    expect(dispatchOrder.indexOf('quality-review')).toBeGreaterThanOrEqual(0)
    expect(dispatchOrder.indexOf('spec-review')).toBeLessThan(ctrlIdx)
    expect(dispatchOrder.indexOf('quality-review')).toBeLessThan(ctrlIdx)
  }, 120_000) // real git worktree ops for the fan-in merge — slow on Windows
})

/**
 * pipeline-dispatch (C1) — the K/Chief→pipeline delegation queue + relay (TOKEN-FREE).
 *
 * The EXECUTION half of the two-phase decoupling, mirroring the PROVEN lead-dispatch relay:
 * `delegate_pipeline` (k-store.ts, in the ephemeral MCP child) only RECORDS a 'pending' intent;
 * `drainPipelineDispatches()` (pipeline-dispatch-relay.ts, in the long-lived main process) claims +
 * executes each intent via startPipelineRun. No `claude` ever spawns — startPipelineRun only
 * INSTANTIATES the pipeline ledger (the scheduler, not driven here, would dispatch stages), so we
 * assert a `pipeline_run` row was created + linked, never that agents ran. Real git only for the
 * throwaway repo startPipelineRun snapshots as base_commit. Proves:
 *   a) delegate_pipeline records a pending dispatch (+ rejects an unknown pipelineId);
 *   b) the drain claims a pending dispatch, starts the SEEDED `investigate` pipeline on the scoped
 *      project's repo, and links pipeline_run_id;
 *   c) claimPipelineDispatch is an atomic pending→dispatched CAS — a second claimant is a no-op;
 *   d) reconcile — a `dispatched` dispatch with null pipeline_run_id → `failed` (pending / linked
 *      rows untouched);
 *   e) onPipelineTerminal — finalizing a pipeline invokes registered listeners with the status.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, pipelineDb, projectsDb, agentRunsDb } from '../src/db.js'
import { seedPipelineSpecs } from '../src/pipeline-seeds.js'
import { seedProfiles } from '../src/profiles.js'
import { kStoreTools } from '../src/mcp/k-store.js'
import { startPipelineRun } from '../src/pipeline-defs.js'
import { drainPipelineDispatches, startPipelineDispatchRelay } from '../src/pipeline-dispatch-relay.js'
import { onPipelineTerminal, maybeFinalizePipeline, type PipelineRunRow } from '../src/pipeline-engine.js'
import { getPipelineRunView } from '../src/pipeline-views.js'
import { reconcileOrphanedPipelineDispatches } from '../src/supervisor.js'

const bases: string[] = []
const createdPipelineIds = new Set<string>()
const createdDispatchIds = new Set<string>()
const createdProjectIds = new Set<string>()
const K_RUN = `pl-dispatch-k-run-${uuid().slice(0, 8)}` // the delegating K run (a real runs row)
// A second delegating run, backed by a real agent_runs activation row (profile 'lead-backend'),
// so the owner-stamping test (I-1) has a run whose delegating orchestrator IS resolvable — mirrors
// how a real lead's turn calls delegate_pipeline. K_RUN above deliberately has NO agent_runs row
// (a bare `runs` row, like askK's own chat run), so it stays the "unresolvable owner" fixture.
const OWNED_K_RUN = `pl-dispatch-owned-run-${uuid().slice(0, 8)}`
const OWNER_PROFILE_ID = 'lead-backend'
let ownedAgentRunId: string | null = null

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** An isolated throwaway git repo a pipeline can fork from. */
function makeRepo(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-dispatch-'))
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

/** Register a project pointing at a fresh throwaway repo; returns { id, name }. */
function makeProject(): { id: string; name: string } {
  const localPath = makeRepo()
  const id = uuid()
  const name = `pl-dispatch-proj-${uuid().slice(0, 8)}`
  projectsDb.insertProject.run({
    id, name, localPath, githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  createdProjectIds.add(id)
  return { id, name }
}

/** Invoke a kstore tool by name (as the k-store server would). */
function callTool(name: string, args: unknown, ctx: { runId: string | null }): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}

interface DelegateResult { dispatchId: string; pipelineId: string; projectId: string | null; status: 'pending' }

function delegate(args: Record<string, unknown>, runId: string | null = K_RUN): DelegateResult {
  const res = callTool('delegate_pipeline', args, { runId }) as DelegateResult
  createdDispatchIds.add(res.dispatchId)
  return res
}

const dispatchRow = (id: string) => pipelineDb.getPipelineDispatch.get(id) as Record<string, unknown>

beforeAll(() => {
  // The 3 executable pipeline specs (so 'investigate' resolves) + a real delegating K run row.
  seedPipelineSpecs()
  // The durable org roster (idempotent, by name) — OWNER_PROFILE_ID ('lead-backend') must exist for
  // the agent_runs FK below; safe to call even if another suite already seeded it.
  seedProfiles()
  db.prepare(`INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'done', ?)`)
    .run(K_RUN, Date.now())
  db.prepare(`INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'k', '.', 'done', ?)`)
    .run(OWNED_K_RUN, Date.now())
  // OWNED_K_RUN's activation row: the delegating orchestrator's agent_runs.profile_id — the exact
  // seam resolveDispatchOwnerProfileId (pipeline-dispatch-relay.ts) reads via getAgentRunProfileByRunId.
  ownedAgentRunId = uuid()
  agentRunsDb.insertAgentRun.run({
    id: ownedAgentRunId,
    profileId: OWNER_PROFILE_ID,
    runId: OWNED_K_RUN,
    trigger: 'delegation',
    goal: 'lead-backend activation for pipeline-dispatch owner test',
    projectId: null,
    workflowId: null,
    status: 'running',
    createdAt: Date.now(),
    completedAt: null,
  })
  // This suite is the sole producer of pipeline_dispatches; clear any 'pending' leftovers a crashed
  // prior run left in the shared vitest DB so a global drain here only ever sees our own rows.
  db.prepare(`DELETE FROM pipeline_dispatches WHERE status = 'pending'`).run()
})

afterEach(() => {
  // drainPipelineDispatches drains the WHOLE pending queue, so a lingering pending intent would
  // pollute the next test's drain count — delete every dispatch + pipeline we made after each test.
  for (const id of createdDispatchIds) { try { db.prepare(`DELETE FROM pipeline_dispatches WHERE id = ?`).run(id) } catch { /* ignore */ } }
  createdDispatchIds.clear()
  for (const plr of createdPipelineIds) { try { db.prepare(`DELETE FROM pipeline_runs WHERE id = ?`).run(plr) } catch { /* ignore */ } }
  createdPipelineIds.clear()
})

afterAll(() => {
  for (const id of createdProjectIds) { try { db.prepare(`DELETE FROM projects WHERE id = ?`).run(id) } catch { /* ignore */ } }
  if (ownedAgentRunId) db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(ownedAgentRunId)
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(K_RUN)
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(OWNED_K_RUN)
  for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

// ── a. delegate_pipeline records a pending intent ────────────────────────────────

describe('delegate_pipeline (record-only)', () => {
  it('records a pending dispatch scoped to the K run', () => {
    const res = delegate({ pipelineId: 'investigate', goal: 'trace the flaky test' })
    expect(res.status).toBe('pending')
    expect(res.pipelineId).toBe('investigate')
    expect(res.projectId).toBeNull()

    const row = dispatchRow(res.dispatchId)
    expect(row.status).toBe('pending')
    expect(row.pipeline_id).toBe('investigate')
    expect(row.k_run_id).toBe(K_RUN) // scoped to the delegating run
    expect(row.pipeline_run_id).toBeNull() // recorded, NOT executed
    expect(String(row.goal)).toContain('flaky test')
  })

  it('resolves a pipeline by NAME too, and pins the canonical id', () => {
    const res = delegate({ pipelineId: 'Investigate', goal: 'by name' })
    expect(res.pipelineId).toBe('investigate') // the arg was the name; the stored id is canonical
    expect(dispatchRow(res.dispatchId).pipeline_id).toBe('investigate')
  })

  it('rejects an unknown pipelineId (nothing recorded)', () => {
    expect(() => callTool('delegate_pipeline', { pipelineId: 'no-such-pipeline', goal: 'x' }, { runId: K_RUN }))
      .toThrow(/no pipeline definition/i)
  })

  it('rejects an unknown project', () => {
    expect(() => callTool('delegate_pipeline', { pipelineId: 'investigate', goal: 'x', project: 'no-such-project' }, { runId: K_RUN }))
      .toThrow(/not found/i)
  })
})

// ── b. record → drain claims + starts the pipeline + links the run ────────────────

describe('drainPipelineDispatches: record → drain', () => {
  it('claims a pending dispatch, starts the pipeline on the scoped repo, and links pipeline_run_id', async () => {
    const proj = makeProject()
    const { dispatchId, projectId } = delegate({ pipelineId: 'investigate', goal: 'investigate the outage', project: proj.name })
    expect(projectId).toBe(proj.id)

    // Recorded but NOT executed yet.
    expect(dispatchRow(dispatchId).status).toBe('pending')
    expect(dispatchRow(dispatchId).pipeline_run_id).toBeNull()

    // The drain executes the one pending intent in the main process.
    expect(await drainPipelineDispatches()).toBe(1)

    // The intent is retired 'dispatched' with the started pipeline linked.
    const row = dispatchRow(dispatchId)
    expect(row.status).toBe('dispatched')
    const pipelineRunId = String(row.pipeline_run_id)
    expect(pipelineRunId).toBeTruthy()
    createdPipelineIds.add(pipelineRunId)

    // A real pipeline_runs row was instantiated from the investigate definition, scoped to the project.
    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow
    expect(run).toBeTruthy()
    expect(run.definition_id).toBe('investigate')
    expect(run.project_id).toBe(proj.id)
    expect(run.status).toBe('running')
    // K_RUN has no agent_runs activation row (a bare chat run, like askK's own) — the delegating
    // owner is UNRESOLVABLE, so owner_profile_id stays honestly null (I-1: never invented).
    expect(run.owner_profile_id).toBeNull()
    // The seeded investigate DAG materialized its two agent stages.
    const stageKeys = (pipelineDb.listStagesForPipeline.all(pipelineRunId) as Array<{ stage_key: string }>).map(s => s.stage_key)
    expect(stageKeys).toEqual(expect.arrayContaining(['investigator', 'synthesizer']))

    // Nothing left pending — a follow-up drain is a no-op.
    expect(await drainPipelineDispatches()).toBe(0)
  })

  // I-1 (whole-impl review): pipeline_runs.owner_profile_id had no writer, so the orchestrator
  // multi-pipeline view (OrchestratorPipelinesPanel) could never populate. Proves the drain now
  // stamps the DELEGATING orchestrator's profile id, resolved from the dispatch's k_run_id via
  // agent_runs.profile_id (pipeline-dispatch-relay.ts::resolveDispatchOwnerProfileId) — exercising
  // BOTH the raw ledger row AND the getPipelineRunView wire projection the UI actually reads.
  it('stamps owner_profile_id from the delegating orchestrator run, and exposes it on the view', async () => {
    const { dispatchId } = delegate({ pipelineId: 'investigate', goal: 'owner-stamping demo' }, OWNED_K_RUN)
    expect(await drainPipelineDispatches()).toBe(1)

    const pipelineRunId = String(dispatchRow(dispatchId).pipeline_run_id)
    expect(pipelineRunId).toBeTruthy()
    createdPipelineIds.add(pipelineRunId)

    const run = pipelineDb.getPipelineRun.get(pipelineRunId) as PipelineRunRow
    expect(run.owner_profile_id).toBe(OWNER_PROFILE_ID)

    const view = getPipelineRunView(pipelineRunId)
    expect(view?.run.ownerProfileId).toBe(OWNER_PROFILE_ID)
  })
})

// ── c. the atomic pending→dispatched CAS (the cross-process guard) ────────────────

describe('claimPipelineDispatch CAS', () => {
  it('is an atomic pending→dispatched claim — a second claimant loses', () => {
    const { dispatchId } = delegate({ pipelineId: 'investigate', goal: 'cas demo' })
    // First claimant flips pending→dispatched (changes===1); a second concurrent claimant on the
    // same row sees changes===0 — the exactly-once guard the relay relies on across overlapping
    // drains AND (in production) across a single main-process relay.
    expect(pipelineDb.claimPipelineDispatch.run({ id: dispatchId, dispatchedAt: Date.now() }).changes).toBe(1)
    expect(pipelineDb.claimPipelineDispatch.run({ id: dispatchId, dispatchedAt: Date.now() }).changes).toBe(0)
    expect(dispatchRow(dispatchId).status).toBe('dispatched')
    // This intent is now stranded 'dispatched' with no pipeline_run_id — exactly the state the boot
    // sweep reconcileOrphanedPipelineDispatches rescues (asserted next).
  })
})

// ── d. reconcile stranded dispatched intents ─────────────────────────────────────

describe('reconcileOrphanedPipelineDispatches', () => {
  it('fails a dispatched intent with no pipeline_run_id, leaving pending + linked rows untouched', async () => {
    // A pending intent (untouched by the sweep — the drain still owns it).
    const pending = delegate({ pipelineId: 'investigate', goal: 'still pending' })
    // A stranded 'dispatched' intent with no run (the claim window crashed before setPipelineDispatchRun).
    const orphan = delegate({ pipelineId: 'investigate', goal: 'orphaned claim' })
    pipelineDb.claimPipelineDispatch.run({ id: orphan.dispatchId, dispatchedAt: Date.now() })
    // A COMPLETE 'dispatched' intent WITH a real linked pipeline (untouched — retired, not stranded).
    // Built by hand (claim + setPipelineDispatchRun) rather than via the drain, so the drain can't
    // also pick up the still-pending intent above and mislink it.
    const repo = makeRepo()
    const { pipelineRunId } = await startPipelineRun('investigate', { cwd: repo, goal: 'linked run' })
    createdPipelineIds.add(pipelineRunId)
    const linked = delegate({ pipelineId: 'investigate', goal: 'linked run' })
    pipelineDb.claimPipelineDispatch.run({ id: linked.dispatchId, dispatchedAt: Date.now() })
    pipelineDb.setPipelineDispatchRun.run({ id: linked.dispatchId, pipelineRunId })

    const swept = reconcileOrphanedPipelineDispatches(db)
    expect(swept).toBeGreaterThanOrEqual(1)

    expect(dispatchRow(orphan.dispatchId).status).toBe('failed') // the run-less orphan is failed
    expect(dispatchRow(pending.dispatchId).status).toBe('pending') // the pending intent is untouched
    expect(dispatchRow(linked.dispatchId).status).toBe('dispatched') // the linked intent is untouched
    expect(dispatchRow(linked.dispatchId).pipeline_run_id).toBe(pipelineRunId)
  })
})

// ── e. the engine terminal callback fires on finalize ────────────────────────────

describe('onPipelineTerminal', () => {
  it('invokes registered listeners once with the terminal status when a pipeline finalizes', async () => {
    const repo = makeRepo()
    const { pipelineRunId } = await startPipelineRun('investigate', { cwd: repo, goal: 'terminal-callback demo' })
    createdPipelineIds.add(pipelineRunId)

    // Drive the pipeline to a quiesced, all-passed state WITHOUT running agents: mark both stages
    // passed directly, so maybeFinalizePipeline transitions running→completed.
    const now = Date.now()
    for (const s of pipelineDb.listStagesForPipeline.all(pipelineRunId) as Array<{ id: string }>) {
      pipelineDb.markStagePassed.run({ id: s.id, resultCommit: null, exitCode: 0, costUsd: null, updatedAt: now, completedAt: now })
    }

    const calls: Array<{ id: string; status: string }> = []
    const unsub = onPipelineTerminal((id, status) => { calls.push({ id, status }) })
    try {
      maybeFinalizePipeline(pipelineRunId)
      expect((pipelineDb.getPipelineRun.get(pipelineRunId) as { status: string }).status).toBe('completed')
      // The listener fired exactly once with this pipeline's terminal status.
      const mine = calls.filter(c => c.id === pipelineRunId)
      expect(mine).toEqual([{ id: pipelineRunId, status: 'completed' }])
      // Idempotent: a second finalize on the now-terminal pipeline does NOT re-fire.
      maybeFinalizePipeline(pipelineRunId)
      expect(calls.filter(c => c.id === pipelineRunId)).toHaveLength(1)
    } finally {
      unsub()
    }
  })
})

// ── startPipelineDispatchRelay wiring ────────────────────────────────────────────

describe('startPipelineDispatchRelay', () => {
  it('returns a stop fn that is safe to call', () => {
    const stop = startPipelineDispatchRelay({ intervalMs: 60_000 })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('with PIPELINE_DISPATCH_RELAY=0 returns a no-op and wires no interval', () => {
    const prev = process.env.PIPELINE_DISPATCH_RELAY
    const spy = vi.spyOn(global, 'setInterval')
    process.env.PIPELINE_DISPATCH_RELAY = '0'
    try {
      const stop = startPipelineDispatchRelay()
      expect(spy).not.toHaveBeenCalled()
      expect(() => stop()).not.toThrow()
    } finally {
      spy.mockRestore()
      if (prev === undefined) delete process.env.PIPELINE_DISPATCH_RELAY
      else process.env.PIPELINE_DISPATCH_RELAY = prev
    }
  })
})

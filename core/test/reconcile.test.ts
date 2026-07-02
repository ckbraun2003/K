/**
 * C1 — crash-recovery boot sweep. reconcileStaleRuns() flips runs left in a
 * non-terminal status by a crash to `interrupted` and nulls their worktree,
 * while leaving already-terminal runs untouched. Tested against a temp DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import {
  reconcileStaleRuns,
  reconcileStaleActivations,
  reconcileOrphanedActivations,
  reconcileOrphanedLeadDispatches,
  reconcileStaleKThreads,
} from '../src/supervisor.js'

const tmpPath = path.join(os.tmpdir(), `k-reconcile-${Date.now()}.db`)
let tempDb: Database.Database

const RUN_RUNNING = uuid()
const RUN_QUEUED = uuid()
const RUN_DONE = uuid()

function seed(d: Database.Database) {
  d.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
      status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, ended_at INTEGER
    );
  `)
  const ins = d.prepare(
    `INSERT INTO runs (id, prompt, cwd, worktree, status, created_at)
     VALUES (?, 'p', '/tmp', ?, ?, ?)`,
  )
  ins.run(RUN_RUNNING, '/tmp/.worktrees/a', 'running', Date.now())
  ins.run(RUN_QUEUED, '/tmp/.worktrees/b', 'queued', Date.now())
  ins.run(RUN_DONE, '/tmp/.worktrees/c', 'done', Date.now())
}

afterAll(() => {
  try { tempDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
})

describe('reconcileStaleRuns', () => {
  it('marks running + queued runs interrupted and nulls their worktree; leaves done untouched', () => {
    tempDb = new Database(tmpPath)
    seed(tempDb)

    const n = reconcileStaleRuns(tempDb)
    expect(n).toBe(2)

    const get = tempDb.prepare('SELECT status, worktree, ended_at FROM runs WHERE id = ?')
    const running = get.get(RUN_RUNNING) as { status: string; worktree: string | null; ended_at: number | null }
    const queued = get.get(RUN_QUEUED) as { status: string; worktree: string | null; ended_at: number | null }
    const done = get.get(RUN_DONE) as { status: string; worktree: string | null }

    expect(running.status).toBe('interrupted')
    expect(running.worktree).toBeNull()
    expect(running.ended_at).not.toBeNull()

    expect(queued.status).toBe('interrupted')
    expect(queued.worktree).toBeNull()

    // already-terminal run is untouched (status + worktree preserved)
    expect(done.status).toBe('done')
    expect(done.worktree).toBe('/tmp/.worktrees/c')
  })

  it('is idempotent — a second sweep finds nothing stale', () => {
    expect(reconcileStaleRuns(tempDb)).toBe(0)
  })
})

/**
 * reconcileStaleActivations() flips agent_runs tracking rows left 'running' by a
 * crash to terminal 'failed', while leaving already-terminal activations untouched.
 * A crash-orphaned 'running' chief activation would otherwise defeat the Chief
 * autonomous-wake already-running guard (chief-wake.ts Guard B) forever. Temp DB.
 */
const AR_TMP_PATH = path.join(os.tmpdir(), `k-reconcile-ar-${Date.now()}.db`)
let arDb: Database.Database

const AR_RUNNING = uuid()
const AR_COMPLETED = uuid()
const AR_FAILED = uuid()

function seedActivations(d: Database.Database) {
  // Minimal agent_runs shape the sweep touches — no FKs needed for this unit.
  d.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, run_id TEXT, trigger TEXT NOT NULL,
      goal TEXT, project_id TEXT, workflow_id TEXT,
      status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, completed_at INTEGER
    );
  `)
  const ins = d.prepare(
    `INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at, completed_at)
     VALUES (?, 'chief', NULL, 'schedule', 'g', ?, ?, ?)`,
  )
  ins.run(AR_RUNNING, 'running', Date.now(), null)
  ins.run(AR_COMPLETED, 'completed', Date.now(), Date.now())
  ins.run(AR_FAILED, 'failed', Date.now(), Date.now())
}

afterAll(() => {
  try { arDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(AR_TMP_PATH) } catch { /* ignore */ }
})

describe('reconcileStaleActivations', () => {
  it('flips running activations to failed (with completed_at); leaves terminal ones untouched', () => {
    arDb = new Database(AR_TMP_PATH)
    seedActivations(arDb)

    const n = reconcileStaleActivations(arDb)
    expect(n).toBe(1)

    const get = arDb.prepare('SELECT status, completed_at FROM agent_runs WHERE id = ?')
    const running = get.get(AR_RUNNING) as { status: string; completed_at: number | null }
    const completed = get.get(AR_COMPLETED) as { status: string }
    const failed = get.get(AR_FAILED) as { status: string }

    expect(running.status).toBe('failed')
    expect(running.completed_at).not.toBeNull()
    // already-terminal activations are untouched
    expect(completed.status).toBe('completed')
    expect(failed.status).toBe('failed')
  })

  it('is idempotent — a second sweep finds nothing stale', () => {
    expect(reconcileStaleActivations(arDb)).toBe(0)
  })
})

/**
 * reconcileOrphanedActivations() finalizes agent_runs rows stuck 'running' whose LINKED
 * run is ALREADY terminal — the precise safety net for a mgmt-server child that exited
 * mid-dispatch (its finalize subscriber died with it). It derives the activation status
 * FROM the run's terminal status (done→completed, any other terminal→failed) — strictly
 * more correct than the blanket reconcileStaleActivations, which it runs before. A running
 * activation whose run is still live/absent is UNTOUCHED. Temp DB with both tables.
 */
const ORPH_TMP_PATH = path.join(os.tmpdir(), `k-reconcile-orph-${Date.now()}.db`)
let orphDb: Database.Database

const ORPH_DONE = uuid()        // running activation, run done      → completed
const ORPH_INTERRUPTED = uuid() // running activation, run interrupted → failed
const ORPH_NORUN = uuid()       // running activation, run_id NULL   → untouched
const ORPH_COMPLETED = uuid()   // already-completed activation      → untouched

const RUN_OK = uuid()
const RUN_INT = uuid()

function seedOrphaned(d: Database.Database) {
  // Both tables — the sweep JOINs agent_runs → runs on run_id. No real FK needed here.
  d.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
      status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, run_id TEXT, trigger TEXT NOT NULL,
      goal TEXT, project_id TEXT, workflow_id TEXT,
      status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, completed_at INTEGER
    );
  `)
  const insRun = d.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'p', '/tmp', ?, ?)`)
  insRun.run(RUN_OK, 'done', Date.now())
  insRun.run(RUN_INT, 'interrupted', Date.now())
  const insAr = d.prepare(
    `INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at, completed_at)
     VALUES (?, 'lead-frontend', ?, 'delegation', 'g', ?, ?, ?)`,
  )
  insAr.run(ORPH_DONE, RUN_OK, 'running', Date.now(), null)
  insAr.run(ORPH_INTERRUPTED, RUN_INT, 'running', Date.now(), null)
  insAr.run(ORPH_NORUN, null, 'running', Date.now(), null)
  insAr.run(ORPH_COMPLETED, RUN_OK, 'completed', Date.now(), Date.now())
}

beforeAll(() => {
  orphDb = new Database(ORPH_TMP_PATH)
  seedOrphaned(orphDb)
})

afterAll(() => {
  try { orphDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(ORPH_TMP_PATH) } catch { /* ignore */ }
})

describe('reconcileOrphanedActivations', () => {
  it('finalizes running activations by their terminal run status; leaves live/terminal ones untouched', () => {
    const n = reconcileOrphanedActivations(orphDb)
    expect(n).toBe(2)

    const get = orphDb.prepare('SELECT status, completed_at FROM agent_runs WHERE id = ?')
    const done = get.get(ORPH_DONE) as { status: string; completed_at: number | null }
    const interrupted = get.get(ORPH_INTERRUPTED) as { status: string; completed_at: number | null }
    const norun = get.get(ORPH_NORUN) as { status: string }
    const completed = get.get(ORPH_COMPLETED) as { status: string }

    // done run → completed activation; interrupted run → failed activation (both stamped).
    expect(done.status).toBe('completed')
    expect(done.completed_at).not.toBeNull()
    expect(interrupted.status).toBe('failed')
    expect(interrupted.completed_at).not.toBeNull()
    // a running activation with no linked run is NOT this sweep's job — left running.
    expect(norun.status).toBe('running')
    // an already-terminal activation is untouched.
    expect(completed.status).toBe('completed')
  })

  it('is idempotent — a second sweep finds nothing to finalize', () => {
    expect(reconcileOrphanedActivations(orphDb)).toBe(0)
  })
})

/**
 * reconcileOrphanedLeadDispatches() rescues lead-dispatch intents stranded 'dispatched'
 * with lead_run_id NULL — the relay claimed (pending→dispatched) but the main process
 * crashed before startAgentRun recorded a run. Such a row is never re-drained yet blocks
 * re-dispatch, so the sweep marks it 'failed' (assignment link stays NULL → retryable).
 * A 'dispatched' row that DID record a lead_run_id (executed fine, just mid-run at crash)
 * and a still-'pending' row are BOTH left untouched. Temp DB with the lead_dispatches table.
 */
const LD_TMP_PATH = path.join(os.tmpdir(), `k-reconcile-ld-${Date.now()}.db`)
let ldDb: Database.Database

const LD_STRANDED = uuid()   // dispatched, lead_run_id NULL   → failed
const LD_EXECUTED = uuid()   // dispatched, lead_run_id set    → untouched
const LD_PENDING = uuid()    // pending (not yet claimed)      → untouched

function seedLeadDispatches(d: Database.Database) {
  d.exec(`
    CREATE TABLE lead_dispatches (
      id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, chief_run_id TEXT,
      lead_profile_id TEXT NOT NULL, lead TEXT NOT NULL, workflow_id TEXT NOT NULL,
      goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      lead_run_id TEXT, created_at INTEGER NOT NULL, dispatched_at INTEGER
    );
  `)
  const ins = d.prepare(
    `INSERT INTO lead_dispatches (id, assignment_id, lead_profile_id, lead, workflow_id, goal, status, lead_run_id, created_at, dispatched_at)
     VALUES (?, 'asg', 'lead-frontend', 'Frontend', 'code-wave', 'g', ?, ?, ?, ?)`,
  )
  ins.run(LD_STRANDED, 'dispatched', null, Date.now(), Date.now())
  ins.run(LD_EXECUTED, 'dispatched', 'run-executed', Date.now(), Date.now())
  ins.run(LD_PENDING, 'pending', null, Date.now(), null)
}

beforeAll(() => {
  ldDb = new Database(LD_TMP_PATH)
  seedLeadDispatches(ldDb)
})

afterAll(() => {
  try { ldDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(LD_TMP_PATH) } catch { /* ignore */ }
})

/**
 * reconcileStaleKThreads() clears k_threads stuck pointing at a DEAD warm run — the
 * live-observed crash/boot symptom: status='active' with an active_run_id whose run
 * is terminal (the captureAnswers subscriber died with the process) or missing
 * entirely. A thread whose run is still live, and an already-idle thread, are BOTH
 * untouched. Temp DB with runs + k_threads (no FK needed for this unit).
 */
const KT_TMP_PATH = path.join(os.tmpdir(), `k-reconcile-kt-${Date.now()}.db`)
let ktDb: Database.Database

const KT_TERMINAL = 'kt-terminal'   // active, run done         → cleared + idle
const KT_MISSING = 'kt-missing'     // active, run row missing  → cleared + idle
const KT_LIVE = 'kt-live'           // active, run running      → untouched
const KT_IDLE = 'kt-idle'           // already idle, null run   → untouched

const KT_RUN_DONE = uuid()
const KT_RUN_LIVE = uuid()

function seedKThreads(d: Database.Database) {
  d.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
      status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE k_threads (
      id TEXT PRIMARY KEY, title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle')),
      active_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  const insRun = d.prepare(`INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'p', '/tmp', ?, ?)`)
  insRun.run(KT_RUN_DONE, 'done', Date.now())
  insRun.run(KT_RUN_LIVE, 'running', Date.now())
  const insThread = d.prepare(
    `INSERT INTO k_threads (id, title, status, active_run_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 1)`,
  )
  insThread.run(KT_TERMINAL, 'active', KT_RUN_DONE, Date.now())
  insThread.run(KT_MISSING, 'active', 'no-such-run', Date.now())
  insThread.run(KT_LIVE, 'active', KT_RUN_LIVE, Date.now())
  insThread.run(KT_IDLE, 'idle', null, Date.now())
}

beforeAll(() => {
  ktDb = new Database(KT_TMP_PATH)
  seedKThreads(ktDb)
})

afterAll(() => {
  try { ktDb?.close() } catch { /* ignore */ }
  try { fs.unlinkSync(KT_TMP_PATH) } catch { /* ignore */ }
})

describe('reconcileStaleKThreads', () => {
  it('clears threads pointing at a terminal or missing run; leaves live + idle threads untouched', () => {
    const n = reconcileStaleKThreads(ktDb)
    expect(n).toBe(2)

    const get = ktDb.prepare('SELECT status, active_run_id, updated_at FROM k_threads WHERE id = ?')
    const terminal = get.get(KT_TERMINAL) as { status: string; active_run_id: string | null; updated_at: number }
    const missing = get.get(KT_MISSING) as { status: string; active_run_id: string | null }
    const live = get.get(KT_LIVE) as { status: string; active_run_id: string | null }
    const idle = get.get(KT_IDLE) as { status: string; active_run_id: string | null; updated_at: number }

    // terminal-run thread: cleared + idle, updated_at stamped.
    expect(terminal.status).toBe('idle')
    expect(terminal.active_run_id).toBeNull()
    expect(terminal.updated_at).toBeGreaterThan(1)
    // missing-run thread: cleared + idle.
    expect(missing.status).toBe('idle')
    expect(missing.active_run_id).toBeNull()
    // live-run thread: untouched.
    expect(live.status).toBe('active')
    expect(live.active_run_id).toBe(KT_RUN_LIVE)
    // already-idle thread: untouched (updated_at not re-stamped).
    expect(idle.status).toBe('idle')
    expect(idle.active_run_id).toBeNull()
    expect(idle.updated_at).toBe(1)
  })

  it('is idempotent — a second sweep finds nothing stale', () => {
    expect(reconcileStaleKThreads(ktDb)).toBe(0)
  })
})

describe('reconcileOrphanedLeadDispatches', () => {
  it('resets a stranded dispatched-with-no-run intent to failed; leaves executed + pending untouched', () => {
    const n = reconcileOrphanedLeadDispatches(ldDb)
    expect(n).toBe(1)

    const get = ldDb.prepare('SELECT status, lead_run_id FROM lead_dispatches WHERE id = ?')
    const stranded = get.get(LD_STRANDED) as { status: string; lead_run_id: string | null }
    const executed = get.get(LD_EXECUTED) as { status: string; lead_run_id: string | null }
    const pending = get.get(LD_PENDING) as { status: string }

    // stranded → failed (retryable: link still NULL); executed + pending untouched.
    expect(stranded.status).toBe('failed')
    expect(stranded.lead_run_id).toBeNull()
    expect(executed.status).toBe('dispatched')
    expect(executed.lead_run_id).toBe('run-executed')
    expect(pending.status).toBe('pending')
  })

  it('is idempotent — a second sweep finds nothing stranded', () => {
    expect(reconcileOrphanedLeadDispatches(ldDb)).toBe(0)
  })
})

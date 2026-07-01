/**
 * C1 — crash-recovery boot sweep. reconcileStaleRuns() flips runs left in a
 * non-terminal status by a crash to `interrupted` and nulls their worktree,
 * while leaving already-terminal runs untouched. Tested against a temp DB.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { reconcileStaleRuns, reconcileStaleActivations } from '../src/supervisor.js'

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

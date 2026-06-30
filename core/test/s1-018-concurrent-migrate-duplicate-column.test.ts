/**
 * REGRESSION — FAULT S1-018 (FIXED + promoted to gating, reboot wave F1.W2).
 * Finding: testing/findings/S1-database-persistence.md → row S1-018.
 *
 * Defect: core/src/db.ts migrate() adds two columns via INLINE, NON-tolerant
 * ALTERs that are guarded only by a hasColumn() TOCTOU check:
 *   - runs.project_id                       (db.ts:257-261)
 *   - verification_reports.score_breakdown  (db.ts:268-274)
 * The addColumn() helper (db.ts:246-253) deliberately swallows SQLite's
 * "duplicate column name" so a concurrent connection that just added the column
 * does not crash the migration. These two inline ALTERs do NOT use that helper.
 *
 * Impact: when several connections initialize the SAME fresh DB concurrently
 * (multi-process boot, or — observed live — parallel vitest workers sharing one
 * K_DATA_DIR/k.db), they all pass hasColumn()=false, then race the ALTER; the
 * loser throws `SqliteError: duplicate column name: score_breakdown` out of
 * migrate(), crashing db.ts module initialization / server boot.
 *   verification_reports.score_breakdown is the reliable trigger because it is
 * absent from the CREATE TABLE DDL (runs.project_id IS in the DDL, so its branch
 * is normally skipped on a fresh DB).
 *
 * Reproduction: N worker threads each load the REAL migrate() and park on an
 * Atomics barrier, then fire migrate() on one shared pre-seeded DB in lockstep.
 * The pre-seed gives runs (with project_id) + its indexes and omits
 * events/project_tasks, so score_breakdown's ALTER is migrate()'s ONLY write —
 * maximizing overlap. We assert NO worker ever throws "duplicate column name".
 *
 * FIXED: both inline ALTERs now route through the tolerant addColumn() helper, so
 * the loser of the ALTER race swallows "duplicate column name" instead of crashing
 * → zero duplicate-column errors → this test is green and now gates.
 *
 * Document-only: this test does not edit core/src/**. It drives migrate() from
 * the outside via worker threads.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
// Rule: quarantine tests reference the source under test. The workers load this
// exact module to exercise the real migrate(); we also resolve its path from here.
import { migrate as _migrate } from '../src/db.js'
void _migrate

const dbTsUrl = new URL('../src/db.js', import.meta.url).href
const corePkgPath = fileURLToPath(new URL('../package.json', import.meta.url))

// Pre-migration shape: runs already carries project_id + both indexes (those
// branches are no-ops), verification_reports lacks score_breakdown, and
// events/project_tasks are ABSENT so migrate()'s only write is the score_breakdown
// ALTER — no earlier write staggers the concurrent connections.
const PRE_DDL = `
  CREATE TABLE projects(id TEXT PRIMARY KEY);
  CREATE TABLE runs(id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'queued', project_id TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE INDEX idx_runs_project ON runs(project_id);
  CREATE INDEX idx_runs_created_at ON runs(created_at);
  CREATE TABLE verification_reports(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, score INTEGER NOT NULL,
    findings TEXT NOT NULL DEFAULT '[]', fixes_applied TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL, completed_at INTEGER);
`

const WORKER_SRC = `
import { workerData, parentPort } from 'worker_threads'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
const require = createRequire(workerData.corePkgPath)
const Database = require('better-sqlite3')
// Register tsx's ESM loader in THIS worker thread so it can import the .ts source.
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
register()
const { migrate } = await import(workerData.dbTsUrl)
const flag = new Int32Array(workerData.sab)
const d = new Database(workerData.raceFile)
Atomics.add(flag, 1, 1)   // signal ready
Atomics.wait(flag, 0, 0)  // park until released
try { migrate(d); parentPort.postMessage({ kind: 'ok' }) }
catch (e) {
  const msg = String(e && e.message)
  parentPort.postMessage({ kind: /duplicate column name/.test(msg) ? 'dup' : 'other', msg })
}
d.close()
`

const N = 12
const ITERS = 4
const tmpFiles: string[] = []
let workerFile = ''

afterAll(() => {
  for (const p of [...tmpFiles, workerFile]) for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + ext) } catch { /* ignore */ }
  }
})

function runIteration(it: number): Promise<Array<{ kind: string; msg?: string }>> {
  const raceFile = path.join(os.tmpdir(), `k-s1-018-${process.pid}-${it}-${Math.random()}.db`)
  tmpFiles.push(raceFile)
  const seed = new Database(raceFile)
  seed.pragma('journal_mode = WAL')
  seed.exec(PRE_DDL)
  seed.close()

  const sab = new SharedArrayBuffer(8)
  const flag = new Int32Array(sab) // [0]=release, [1]=ready count
  const msgs: Array<{ kind: string; msg?: string }> = []
  const workers = Array.from({ length: N }, (_, i) =>
    new Worker(workerFile, {
      workerData: { raceFile, sab, dbTsUrl, corePkgPath },
      env: { ...process.env, K_DATA_DIR: path.join(os.tmpdir(), `k-s1-018-self-${process.pid}-${it}-${i}`) },
    }))

  const done = Promise.all(workers.map(w => new Promise<void>(res => {
    w.on('message', (m: { kind: string; msg?: string }) => { msgs.push(m); res() })
    w.on('error', e => { msgs.push({ kind: 'other', msg: String(e.message) }); res() })
  })))

  return (async () => {
    const deadline = Date.now() + 30_000
    while (Atomics.load(flag, 1) < N) {
      if (Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 5))
    }
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
    await done
    await Promise.all(workers.map(w => w.terminate()))
    return msgs
  })()
}

describe('S1-018 — concurrent migrate() tolerates the ADD COLUMN race (gating)', () => {
  it('no concurrent connection throws "duplicate column name"', async () => {
    workerFile = path.join(os.tmpdir(), `k-s1-018-worker-${process.pid}-${Math.random()}.mjs`)
    fs.writeFileSync(workerFile, WORKER_SRC)

    let dup = 0
    let ok = 0
    let other = 0
    const otherMsgs: string[] = []
    for (let i = 0; i < ITERS; i++) {
      const msgs = await runIteration(i)
      for (const m of msgs) {
        if (m.kind === 'dup') dup++
        else if (m.kind === 'ok') ok++
        else { other++; if (m.msg) otherMsgs.push(m.msg) }
      }
    }

    // Harness sanity: every worker reported, and none failed for infra reasons
    // (tsx/import). Otherwise we cannot trust the result — fail loudly, not silently.
    expect(other, `non-race worker errors: ${otherMsgs.slice(0, 3).join(' | ')}`).toBe(0)
    expect(ok + dup).toBe(N * ITERS)

    // THE FAULT: today the losers of the ALTER race throw → dup > 0 → this fails (red).
    // After both inline ALTERs route through the tolerant addColumn() helper, dup === 0.
    expect(dup, `concurrent migrate() threw "duplicate column name" ${dup} time(s)`).toBe(0)
  }, 180_000)
})

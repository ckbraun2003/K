/**
 * Regenerate core/test/fixtures/poisoned-prev-gen.db (DEH-FU-3).
 *
 * Shape: the CURRENT full boot schema with the newest generation's columns REMOVED
 * (artifacts/eval_results rebuilt to their v12 shapes) while user_version keeps the
 * CURRENT stamp — the "poisoned stamp" class that took the stack down on 2026-07-13.
 * The committed fixture lets CI boot the real server against it (upgrade-smoke.mjs),
 * proving module-level prepares survive via the sentinel self-heal — a guarantee the
 * migrate() unit tests structurally cannot give.
 *
 * REGEN CONTRACT: re-run this after EVERY SCHEMA_VERSION bump, updating the rebuild
 * SQL below to strip the NEW version's columns (and keep the old strip lines).
 *   node core/scripts/make-poisoned-fixture.mjs
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.resolve(here, '..')
const outPath = path.join(coreDir, 'test', 'fixtures', 'poisoned-prev-gen.db')

// 1. Materialize the FULL current schema by importing the db module against a
//    scratch K_DATA_DIR (the module-level DDL exec + migrate() run on import).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k-poison-fixture-'))
await execa(process.execPath, ['--import', 'tsx', '-e', "import('./src/db.js').then(() => process.exit(0))"], {
  cwd: coreDir,
  env: { ...process.env, K_DATA_DIR: tmp, HARNESS_TOKEN: 'fixture' },
})

// 2. Rebuild the v13 tables to their PREVIOUS-generation shapes on a copy,
//    keeping the CURRENT user_version stamp (that IS the poison).
const d = new Database(path.join(tmp, 'k.db'))
d.pragma('journal_mode = DELETE') // single-file fixture: no -wal/-shm sidecars
d.exec(`
  BEGIN;
  CREATE TABLE artifacts_v12 (slug TEXT PRIMARY KEY, title TEXT NOT NULL, phase TEXT, status TEXT,
    tags TEXT NOT NULL DEFAULT '[]', linked_run_id TEXT, updated_at INTEGER NOT NULL,
    md TEXT NOT NULL, html_path TEXT);
  INSERT INTO artifacts_v12 SELECT slug, title, phase, status, tags, linked_run_id, updated_at, md, html_path FROM artifacts;
  DROP TABLE artifacts;
  ALTER TABLE artifacts_v12 RENAME TO artifacts;
  CREATE TABLE eval_results_v12 (id TEXT PRIMARY KEY, evalRunId TEXT NOT NULL, systemId TEXT NOT NULL,
    caseId TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, detPass INTEGER, detScore REAL,
    formatScore REAL, judgeOverall REAL, judgeVerdict TEXT, refusalCorrect INTEGER, costUsd REAL,
    ms INTEGER, numTurns INTEGER, error TEXT, raw TEXT, createdAt INTEGER NOT NULL);
  INSERT INTO eval_results_v12 SELECT id, evalRunId, systemId, caseId, model, variant, detPass, detScore,
    formatScore, judgeOverall, judgeVerdict, refusalCorrect, costUsd, ms, numTurns, error, raw, createdAt FROM eval_results;
  DROP TABLE eval_results;
  ALTER TABLE eval_results_v12 RENAME TO eval_results;
  COMMIT;
`)
d.exec('VACUUM')
const stamp = d.pragma('user_version', { simple: true })
d.close()

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.copyFileSync(path.join(tmp, 'k.db'), outPath)
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
console.log(`poisoned fixture written: ${outPath} (user_version=${stamp}, v13 columns stripped)`)

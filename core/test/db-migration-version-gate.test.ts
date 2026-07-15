/**
 * migrate() PRAGMA user_version fast path (B2 item 9).
 *
 * migrate() used to run the FULL guarded-ALTER/backfill scan on every connection
 * open — including each per-run stdio MCP child (up to 3 per K/Chief turn). It is
 * now a version-gated wrapper: user_version === SCHEMA_VERSION → return immediately;
 * otherwise run the full scan (migrateSlow) and stamp the version. The pragma lives
 * in the DB FILE, so every later connection fast-paths.
 *
 * Proof strategy (observable, not timing): a DB manually stamped at the CURRENT
 * SCHEMA_VERSION but MISSING a migrate-added column stays missing after migrate() —
 * only the fast path can explain that. A user_version=0 DB — or one stamped at an
 * OLDER version — gets the full scan (column appears) and is re-stamped. Old-schema
 * fixture patterns follow db-migration.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { migrate, SCHEMA_VERSION, SCHEMA_SENTINEL } from '../src/db.js'

const OLD_SCHEMA_DDL = `
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
  );
  -- pre-v13 shape: the SCHEMA_SENTINEL now lives on artifacts.origin, so the
  -- fast-path fixture needs the table to exist (without the sentinel column).
  CREATE TABLE artifacts (
    slug TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, md TEXT NOT NULL
  );
`

const tmpFiles: string[] = []
function tmpDb(): Database.Database {
  const p = path.join(os.tmpdir(), `k-mig-vgate-${process.pid}-${tmpFiles.length}-${Date.now()}.db`)
  tmpFiles.push(p)
  return new Database(p)
}

const cols = (d: Database.Database, t: string) =>
  (d.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
const version = (d: Database.Database) => d.pragma('user_version', { simple: true }) as number

afterAll(() => {
  for (const p of tmpFiles) for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + ext) } catch { /* ignore */ }
  }
})

describe('migrate() — user_version fast path', () => {
  it('an old-schema DB (user_version 0) gets the full scan AND is stamped', () => {
    const d = tmpDb()
    d.exec(OLD_SCHEMA_DDL)
    expect(version(d)).toBe(0)

    migrate(d)

    expect(cols(d, 'runs')).toContain('project_id') // the full scan ran
    expect(version(d)).toBe(SCHEMA_VERSION) // …and stamped the schema version
    d.close()
  })

  it('a DB pre-stamped at the CURRENT version WITH the sentinel column fast-paths (an unrelated column stays missing)', () => {
    const d = tmpDb()
    d.exec(OLD_SCHEMA_DDL)
    // Stamp + sentinel must agree for the fast path (F1 poisoned-stamp guard —
    // see db-migration-poisoned-stamp.test.ts): a stamp without the sentinel
    // column now forces the full scan instead of trusting the stamp.
    d.exec(`ALTER TABLE ${SCHEMA_SENTINEL.table} ADD COLUMN ${SCHEMA_SENTINEL.column} REAL`)
    d.pragma(`user_version = ${SCHEMA_VERSION}`)

    migrate(d)

    // The ONLY way project_id can still be missing is that migrate() returned on
    // the version gate before the guarded ALTERs — the fast path took it.
    expect(cols(d, 'runs')).not.toContain('project_id')
    d.close()
  })

  it('a user_version=0 DB always gets the full path (a later boot after a version rollback)', () => {
    const d = tmpDb()
    d.exec(OLD_SCHEMA_DDL)
    migrate(d)
    expect(version(d)).toBe(SCHEMA_VERSION)

    // Simulate an operator/tool resetting the stamp: the full (idempotent) scan
    // re-runs without throwing and re-stamps.
    d.pragma('user_version = 0')
    migrate(d)
    expect(version(d)).toBe(SCHEMA_VERSION)
    expect(cols(d, 'runs')).toContain('project_id')
    d.close()
  })

  it('a DB stamped at an OLDER version (literal 1) re-enters the full scan and is re-stamped to the CURRENT version', () => {
    const d = tmpDb()
    d.exec(OLD_SCHEMA_DDL)
    // The literal OLD version — that is the point: version bumps must re-open the gate.
    d.pragma('user_version = 1')

    migrate(d)

    expect(cols(d, 'runs')).toContain('project_id') // the full scan ran
    expect(version(d)).toBe(SCHEMA_VERSION)
    d.close()
  })

  it('a failed full scan does NOT stamp the version (the next boot retries)', () => {
    const d = tmpDb() // empty DB: migrate()'s unguarded runs ALTER throws "no such table"
    expect(() => migrate(d)).toThrow(/no such table/i)
    expect(version(d)).toBe(0)
    d.close()
  })
})

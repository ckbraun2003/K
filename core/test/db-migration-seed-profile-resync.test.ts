/**
 * One-shot seed-profile authority resync (SCHEMA_VERSION 2).
 *
 * DBs seeded before B1 carry authority arrays FROZEN at seed time — verified
 * live: an upgraded DB's `chief` row lacked mcp__mgmt/mgmt, so B1 row-enforcement
 * stripped the Chief's management server on exactly the DBs that upgraded (fresh
 * DBs are correct). The `mig_seed_profile_authority_resync` one-shot re-syncs the
 * SEED rows (fixed ids) from resolveAuthority(row.charter); operator-CREATED
 * profiles (uuid ids) are never touched, and the flag means later operator
 * narrowings survive every subsequent boot.
 *
 * Expectations are computed via resolveAuthority — never a hardcoded roster — so
 * this suite can't drift from the assets. tmpDb/afterAll hygiene mirrors
 * db-migration-version-gate.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { migrate, SCHEMA_VERSION } from '../src/db.js'
import { resolveAuthority } from '../src/authority.js'

// Old-schema fixture (db-migration-version-gate pattern) PLUS the REAL
// agent_profiles DDL (copied from db.ts, incl. the tier/charter CHECKs).
const FIXTURE_DDL = `
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE TABLE agent_profiles (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    tier          TEXT NOT NULL CHECK(tier IN ('secretary','chief','orchestrator')),
    charter       TEXT NOT NULL CHECK(charter IN ('secretary','chief','orchestrator')),
    default_model TEXT NOT NULL,
    allowed_tools TEXT NOT NULL DEFAULT '[]',
    mcp_servers   TEXT NOT NULL DEFAULT '[]',
    skills        TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL
  );
`

// The pre-B1 frozen chief grant (no mcp__mgmt / mgmt) — the live-verified stale shape.
const STALE_CHIEF_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__gitnexus', 'mcp__kstore']

const RESYNC_FLAG = 'mig_seed_profile_authority_resync'

const tmpFiles: string[] = []
function tmpDb(): Database.Database {
  const p = path.join(os.tmpdir(), `k-mig-resync-${process.pid}-${tmpFiles.length}-${Date.now()}.db`)
  tmpFiles.push(p)
  return new Database(p)
}

afterAll(() => {
  for (const p of tmpFiles) for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + ext) } catch { /* ignore */ }
  }
})

function insertStaleChief(d: Database.Database): void {
  d.prepare(
    `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
     VALUES ('chief', 'Chief', 'chief', 'chief', '', ?, '["gitnexus","kstore"]', '[]', ?)`,
  ).run(JSON.stringify(STALE_CHIEF_TOOLS), Date.now())
}

function chiefRow(d: Database.Database): { allowed_tools: string; mcp_servers: string; skills: string } {
  return d.prepare(`SELECT allowed_tools, mcp_servers, skills FROM agent_profiles WHERE id = 'chief'`)
    .get() as { allowed_tools: string; mcp_servers: string; skills: string }
}

describe('migrate() — seed-profile authority resync one-shot', () => {
  it('re-syncs a stale seed row from resolveAuthority(charter) and leaves an operator-created row byte-for-byte untouched', () => {
    const d = tmpDb()
    d.exec(FIXTURE_DDL)
    insertStaleChief(d)
    // Operator-created profile (uuid-ish id — NOT a seed id): a narrowed grant that
    // must survive verbatim.
    d.prepare(
      `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
       VALUES ('custom-op-1', 'Custom', 'orchestrator', 'orchestrator', '', '["Read","Grep"]', '[]', '[]', ?)`,
    ).run(Date.now())
    // Compare the AUTHORED columns only (not SELECT *): later migrations add
    // structural columns with defaults (e.g. plan_gate in v10) that widen the row
    // without touching authority — the resync one-shot must leave these authored
    // fields byte-for-byte identical.
    const AUTHORED_COLS = `id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at`
    const customBefore = d.prepare(`SELECT ${AUTHORED_COLS} FROM agent_profiles WHERE id = 'custom-op-1'`).get()

    migrate(d)

    const expected = resolveAuthority('chief')
    const row = chiefRow(d)
    expect(JSON.parse(row.allowed_tools)).toEqual(expected.allowedTools)
    expect(JSON.parse(row.allowed_tools)).toContain('mcp__mgmt')
    expect(JSON.parse(row.mcp_servers)).toEqual(expected.mcpServers)
    expect(JSON.parse(row.mcp_servers)).toContain('mgmt')
    expect(JSON.parse(row.skills)).toEqual(expected.skills)
    // The operator-created row's authored fields are untouched, byte for byte.
    expect(d.prepare(`SELECT ${AUTHORED_COLS} FROM agent_profiles WHERE id = 'custom-op-1'`).get()).toEqual(customBefore)
    d.close()
  })

  it('is a true one-shot: an operator narrowing made AFTER the resync survives a forced re-scan (the flag blocks the re-run)', () => {
    const d = tmpDb()
    d.exec(FIXTURE_DDL)
    insertStaleChief(d)
    migrate(d)
    expect(d.prepare(`SELECT 1 FROM app_config WHERE key = ?`).get(RESYNC_FLAG)).toBeTruthy()

    // Operator narrows the SEED row post-resync (drops WebFetch)…
    const narrowed = resolveAuthority('chief').allowedTools.filter(t => t !== 'WebFetch')
    d.prepare(`UPDATE agent_profiles SET allowed_tools = ? WHERE id = 'chief'`).run(JSON.stringify(narrowed))
    // …then a later boot forces the FULL scan (user_version fast path bypassed).
    d.pragma('user_version = 0')
    migrate(d)

    expect(JSON.parse(chiefRow(d).allowed_tools)).toEqual(narrowed)
    d.close()
  })

  it('an old-version-stamped DB (user_version=1) gets the resync and is stamped to the CURRENT version', () => {
    const d = tmpDb()
    d.exec(FIXTURE_DDL)
    insertStaleChief(d)
    d.pragma('user_version = 1') // the OLD version — the gate must NOT fast-path it

    migrate(d)

    expect(JSON.parse(chiefRow(d).allowed_tools)).toContain('mcp__mgmt')
    expect(d.pragma('user_version', { simple: true }) as number).toBe(SCHEMA_VERSION)
    d.close()
  })
})

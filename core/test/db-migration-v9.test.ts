/**
 * SCHEMA_VERSION 9 (P1 W0) — review_comments + verify_results.
 * Mirrors db-migration-v8.test.ts: a pre-v9 temp DB gains both tables via
 * migrate(); double-migrate is idempotent; the statement maps round-trip; and
 * deleteProject cleans both tables for the project's runs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  db, migrate, SCHEMA_VERSION, runsDb, projectsDb, eventsDb,
  reviewCommentsDb, verifyResultsDb,
} from '../src/db.js'

const tmp: string[] = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.rmSync(f, { recursive: true, force: true }) } catch { /* */ } } })

function tables(d: Database.Database): string[] {
  return (d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
}

describe('SCHEMA_VERSION 9', () => {
  it('schema is >= 9 and the live DB has both new tables', () => {
    // v9 features exist from v9 onward; the exact current-version pin lives in the
    // latest migration test (db-migration-v10.test.ts), so later bumps don't break this.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9)
    expect(tables(db as unknown as Database.Database)).toEqual(
      expect.arrayContaining(['review_comments', 'verify_results']),
    )
  })

  it('migrates a pre-v9 (v8-shaped) DB idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-v9-'))
    tmp.push(dir)
    const d = new Database(path.join(dir, 'old.db'))
    d.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        worktree TEXT, status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'm', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL,
        github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
        bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', health_score INTEGER,
        last_verified_at INTEGER, created_at INTEGER NOT NULL);
    `)
    migrate(d)
    expect(tables(d)).toEqual(expect.arrayContaining(['review_comments', 'verify_results']))
    // Stamped to the CURRENT version (derived, per the v8-test precedent, so later bumps don't break this).
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    migrate(d) // idempotent — no duplicate-table throw
    expect(tables(d).filter(t => t === 'review_comments')).toHaveLength(1)
    d.close()
  })

  it('statement maps round-trip; deleteProject cleans both tables', () => {
    const pid = randomUUID(); const rid = randomUUID(); const cid = randomUUID()
    projectsDb.insertProject.run({ id: pid, name: `p9-${pid.slice(0, 8)}`, localPath: 'C:\\nowhere\\p9',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: 'C:\\nowhere\\p9', worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })

    reviewCommentsDb.insertReviewComment.run({ id: cid, runId: rid, file: 'src/a.ts', line: 3,
      side: 'new', body: 'tighten this', status: 'draft', createdAt: Date.now() })
    expect((reviewCommentsDb.listReviewComments.all(rid) as unknown[]).length).toBe(1)
    reviewCommentsDb.markDraftCommentsSent.run(rid)
    expect((reviewCommentsDb.getReviewComment.get(cid, rid) as { status: string }).status).toBe('sent')

    verifyResultsDb.upsertVerifyResult.run({ runId: rid, status: 'running', reason: null,
      commands: '[]', scope: null, startedAt: 1, completedAt: null })
    verifyResultsDb.upsertVerifyResult.run({ runId: rid, status: 'pass', reason: null,
      commands: '[{"label":"t","run":"x","exitCode":0,"ok":true,"durationMs":1,"outputTail":""}]',
      scope: '{"files":[],"symbols":null,"indexed":false}', startedAt: 1, completedAt: 2 })
    expect((verifyResultsDb.getVerifyResult.get(rid) as { status: string }).status).toBe('pass')

    projectsDb.setProjectVerifyRecipe.run('{"commands":[{"label":"t","run":"echo ok"}]}', pid)
    expect((projectsDb.getProject.get(pid) as { verify_recipe: string }).verify_recipe).toContain('echo ok')

    projectsDb.deleteProject(pid)
    expect(reviewCommentsDb.listReviewComments.all(rid)).toHaveLength(0)
    expect(verifyResultsDb.getVerifyResult.get(rid)).toBeUndefined()
  })

  it('eventsDb.listCheckpointEvents returns only checkpoint events in seq order', () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: 'C:\\nowhere', worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    const base = { runId: rid, ts: 1, raw: null as string | null, text: null, tool: null, tokensIn: null, tokensOut: null,
      costUsd: null, toolUseId: null, toolKind: null, toolInput: null, toolResult: null,
      toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null }
    eventsDb.insertEvent.run({ ...base, id: randomUUID(), seq: 0, type: 'status', text: 'running' })
    eventsDb.insertEvent.run({ ...base, id: randomUUID(), seq: 5, type: 'checkpoint',
      raw: JSON.stringify({ sha: 'a'.repeat(40), tree: 'b'.repeat(40), ref: `refs/k-checkpoints/${rid}`, wave: 1 }) })
    const rows = eventsDb.listCheckpointEvents.all(rid) as Array<{ seq: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].seq).toBe(5)
  })
})

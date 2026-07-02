/**
 * A1 — lesson profile_id binding + backfill.
 *
 * lesson_propose now resolves the calling run's proposing profile (via its agent_runs
 * activation) and binds agent_memory.profile_id. The migration backfills pre-existing
 * NULL-profile lessons from run_id → the run's most-recent agent_runs.profile_id (best
 * effort — a lesson whose run has no agent_runs row stays NULL).
 *
 * NOTE: the live agent_profiles fixture row is inserted with a RAW db.prepare INSERT
 * (never profiles.ts — a parallel-lane file) and removed in afterAll, so profiles.test.ts
 * still sees a clean roster.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { db, runsDb, projectsDb, agentRunsDb, migrate } from '../src/db.js'
import { kStoreTools, type KStoreContext } from '../src/mcp/k-store.js'
import type { Lesson } from '@k/shared'

const MEM_BACKFILL_FLAG = 'mig_agent_memory_profile_backfill'

function propose(lesson: string, ctx: KStoreContext): Lesson {
  const t = kStoreTools.find(x => x.name === 'lesson_propose')!
  return t.handler({ lesson }, ctx) as Lesson
}

// ── live db: lesson_propose binds profile_id from the run's agent_runs row ──────

describe('A1: lesson_propose binds the proposing profile', () => {
  const PROJECT_ID = uuid()
  const PROFILE_ID = `a1-prof-${uuid().slice(0, 8)}`
  const RUN_WITH = uuid()
  const RUN_WITHOUT = uuid()
  const AGENT_RUN_ID = uuid()
  const createdLessonIds: string[] = []

  beforeAll(() => {
    projectsDb.insertProject.run({
      id: PROJECT_ID, name: `a1-lesson-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/a1-lesson',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
    })
    for (const id of [RUN_WITH, RUN_WITHOUT]) {
      runsDb.insertRun.run({
        id, prompt: 'a1 lesson fixture', cwd: '/tmp/a1-lesson', worktree: null, status: 'running',
        provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
        projectId: PROJECT_ID, createdAt: Date.now(),
      })
    }
    // RAW insert (never profiles.ts) so the roster stays clean after cleanup.
    db.prepare(
      `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
       VALUES (?, ?, 'chief', 'chief', 'sonnet', '[]', '[]', '[]', ?)`,
    ).run(PROFILE_ID, `A1 Prof ${PROFILE_ID}`, Date.now())
    // RUN_WITH has an agent_runs activation for the profile; RUN_WITHOUT does not.
    agentRunsDb.insertAgentRun.run({
      id: AGENT_RUN_ID, profileId: PROFILE_ID, runId: RUN_WITH, trigger: 'delegation',
      goal: null, projectId: null, workflowId: null, status: 'running', createdAt: Date.now(), completedAt: null,
    })
  })

  afterAll(() => {
    for (const id of createdLessonIds) db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(AGENT_RUN_ID)
    db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(PROFILE_ID)
    db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_WITH, RUN_WITHOUT)
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
  })

  it('a run WITH an agent_runs row binds that profile_id', () => {
    const lesson = propose('bind my profile', { runId: RUN_WITH })
    createdLessonIds.push(lesson.id)
    const row = db.prepare('SELECT profile_id FROM agent_memory WHERE id = ?').get(lesson.id) as
      { profile_id: string | null }
    expect(row.profile_id).toBe(PROFILE_ID)
  })

  it('a run WITHOUT an agent_runs row binds profile_id NULL', () => {
    const lesson = propose('no profile for me', { runId: RUN_WITHOUT })
    createdLessonIds.push(lesson.id)
    const row = db.prepare('SELECT profile_id FROM agent_memory WHERE id = ?').get(lesson.id) as
      { profile_id: string | null }
    expect(row.profile_id).toBeNull()
  })
})

// ── temp db: the one-shot backfill migration ──────────────────────────────────

describe('A1: mig_agent_memory_profile_backfill', () => {
  const tmpPath = path.join(os.tmpdir(), `k-a1-lesson-backfill-${Date.now()}.db`)
  let d: Database.Database

  afterAll(() => {
    try { d?.close() } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('backfills NULL profile_id from run_id→agent_runs; leaves an unmatched lesson NULL; is one-shot', () => {
    d = new Database(tmpPath)
    d.pragma('foreign_keys = ON')
    d.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE agent_memory (
        id TEXT PRIMARY KEY, run_id TEXT, lesson TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, reviewed_at INTEGER,
        profile_id TEXT REFERENCES agent_profiles(id)
      );
    `)
    const prof = uuid()
    const runWith = uuid()
    const runWithout = uuid()
    d.prepare(`INSERT INTO agent_profiles (id, name) VALUES (?, 'P')`).run(prof)
    for (const id of [runWith, runWithout]) {
      d.prepare(`INSERT INTO runs (id, prompt, cwd, created_at) VALUES (?, 'x', '.', 1)`).run(id)
    }
    d.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, created_at) VALUES (?, ?, ?, 5)`).run(uuid(), prof, runWith)

    const lessonWith = uuid()
    const lessonWithout = uuid()
    d.prepare(`INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at, profile_id)
               VALUES (?, ?, 'has agent_run', 'pending', 1, NULL, NULL)`).run(lessonWith, runWith)
    d.prepare(`INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at, profile_id)
               VALUES (?, ?, 'no agent_run', 'pending', 1, NULL, NULL)`).run(lessonWithout, runWithout)

    expect(() => migrate(d)).not.toThrow()

    expect((d.prepare('SELECT profile_id FROM agent_memory WHERE id = ?').get(lessonWith) as { profile_id: string | null }).profile_id).toBe(prof)
    expect((d.prepare('SELECT profile_id FROM agent_memory WHERE id = ?').get(lessonWithout) as { profile_id: string | null }).profile_id).toBeNull()
    expect(d.prepare('SELECT 1 FROM app_config WHERE key = ?').get(MEM_BACKFILL_FLAG)).toBeTruthy()

    // One-shot: a NEW null-profile lesson inserted after the flag is set is NOT backfilled.
    // Force the FULL scan (the user_version fast path would skip it) — the FLAG is
    // what must gate the backfill here.
    d.pragma('user_version = 0')
    const afterFlag = uuid()
    d.prepare(`INSERT INTO agent_memory (id, run_id, lesson, status, created_at, reviewed_at, profile_id)
               VALUES (?, ?, 'after flag', 'pending', 1, NULL, NULL)`).run(afterFlag, runWith)
    expect(() => migrate(d)).not.toThrow()
    expect((d.prepare('SELECT profile_id FROM agent_memory WHERE id = ?').get(afterFlag) as { profile_id: string | null }).profile_id).toBeNull()
  })
})

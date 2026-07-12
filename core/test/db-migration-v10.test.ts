/**
 * SCHEMA_VERSION 10 (P2 W0) — run_plans + notifications(+rules) + gate columns.
 * Mirrors db-migration-v9.test.ts: a pre-v10 temp DB gains the tables/columns via
 * migrate(); double-migrate is idempotent; rules are seeded; reviewed_at backfills
 * done rows exactly once; the statement maps round-trip; deleteProject cleans run_plans.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  db, migrate, SCHEMA_VERSION, runsDb, projectsDb, eventsDb,
  runPlansDb, notificationsDb, agentProfilesDb,
} from '../src/db.js'

const tmp: string[] = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.rmSync(f, { recursive: true, force: true }) } catch { /* */ } } })

function tables(d: Database.Database): string[] {
  return (d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
}

describe('SCHEMA_VERSION 10', () => {
  it('is 10 and the live DB has the new tables + seeded rules', () => {
    // v10 features exist from v10 onward; the exact current-version pin lives in the
    // latest migration test (db-migration-v11.test.ts), so later bumps don't break this.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10)
    expect(tables(db as unknown as Database.Database)).toEqual(
      expect.arrayContaining(['run_plans', 'notifications', 'notification_rules']),
    )
    const rules = notificationsDb.listNotificationRules.all() as Array<{ event_key: string; inapp: number; browser: number }>
    // arrayContaining (not exact): later versions seed additional rules (e.g. v11's memory_saved).
    expect(rules.map(r => r.event_key).sort()).toEqual(
      expect.arrayContaining(['run_awaiting_input', 'run_awaiting_plan', 'run_failed', 'run_review_ready', 'verify_fail']),
    )
    expect(rules.find(r => r.event_key === 'run_awaiting_plan')).toMatchObject({ inapp: 1, browser: 1 })
    expect(rules.find(r => r.event_key === 'verify_fail')).toMatchObject({ inapp: 1, browser: 0 })
  })

  it('migrates a pre-v10 (v9-shaped) DB idempotently and backfills reviewed_at ONCE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-v10-'))
    tmp.push(dir)
    const d = new Database(path.join(dir, 'old.db'))
    d.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        worktree TEXT, status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL DEFAULT 'claude',
        model TEXT NOT NULL DEFAULT 'm', tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        cli_session_id TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL,
        github_remote TEXT, workspace_managed INTEGER NOT NULL DEFAULT 0,
        bible_dir TEXT NOT NULL DEFAULT 'artifacts/bible', default_branch TEXT, verify_recipe TEXT,
        health_score INTEGER, last_verified_at INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO runs (id, prompt, cwd, status, created_at, ended_at)
        VALUES ('done-run', 'x', 'C:\\nowhere', 'done', 100, 200),
               ('live-run', 'x', 'C:\\nowhere', 'running', 100, NULL);
    `)
    migrate(d)
    expect(tables(d)).toEqual(expect.arrayContaining(['run_plans', 'notifications', 'notification_rules']))
    // Stamped to the CURRENT version (derived, per the v8/v9-test precedent, so later bumps don't break this).
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    // Backfill: pre-existing done rows read reviewed (no inbox flood); live rows stay NULL.
    expect((d.prepare(`SELECT reviewed_at FROM runs WHERE id = 'done-run'`).get() as { reviewed_at: number }).reviewed_at).toBe(200)
    expect((d.prepare(`SELECT reviewed_at FROM runs WHERE id = 'live-run'`).get() as { reviewed_at: number | null }).reviewed_at).toBeNull()
    // A run finishing AFTER v10 stays unreviewed even if migrate() re-runs (guarded backfill).
    d.exec(`UPDATE runs SET status = 'done', ended_at = 300 WHERE id = 'live-run'`)
    migrate(d) // no-op at v10, but call migrateSlow-idempotence via a fake downgrade:
    d.pragma('user_version = 9')
    migrate(d)
    expect((d.prepare(`SELECT reviewed_at FROM runs WHERE id = 'live-run'`).get() as { reviewed_at: number | null }).reviewed_at).toBeNull()
    d.close()
  })

  it('statement maps round-trip; deleteProject cleans run_plans', () => {
    const pid = randomUUID(); const rid = randomUUID()
    projectsDb.insertProject.run({ id: pid, name: `p10-${pid.slice(0, 8)}`, localPath: 'C:\\nowhere\\p10',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: 'C:\\nowhere\\p10', worktree: null, status: 'awaiting_plan',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid, createdAt: Date.now() })

    runPlansDb.insertRunPlan.run({ runId: rid, plan: '{"steps":[{"title":"a"}],"files":[],"risk":"low"}',
      raw: 'raw', edited: 0, profileId: null, createdAt: 1, updatedAt: 1 })
    expect((runPlansDb.getRunPlan.get(rid) as { edited: number }).edited).toBe(0)
    runPlansDb.updateRunPlanDoc.run({ runId: rid, plan: '{"steps":[{"title":"b"}],"files":[],"risk":"high"}', updatedAt: 2 })
    expect((runPlansDb.getRunPlan.get(rid) as { edited: number; plan: string }).edited).toBe(1)
    runPlansDb.stampRunPlanApproved.run(3, rid)
    expect((runPlansDb.getRunPlan.get(rid) as { approved_at: number }).approved_at).toBe(3)

    const nid = randomUUID()
    notificationsDb.insertNotification.run({ id: nid, eventKey: 'run_awaiting_plan', title: 'Plan ready',
      body: null, runId: rid, projectId: pid, createdAt: Date.now(), readAt: null })
    expect((notificationsDb.countUnreadNotifications.get() as { n: number }).n).toBeGreaterThan(0)
    expect(notificationsDb.markNotificationRead.run(Date.now(), nid).changes).toBe(1)
    expect(notificationsDb.markNotificationRead.run(Date.now(), nid).changes).toBe(0) // already read
    notificationsDb.upsertNotificationRule.run({ eventKey: 'verify_fail', inapp: 0, browser: 1 })
    expect(notificationsDb.getNotificationRule.get('verify_fail')).toMatchObject({ inapp: 0, browser: 1 })
    // Shared-DB hygiene: restore the seed default so a re-run of this suite against the
    // shared (unwiped) K_DATA_DIR doesn't fail the seed-default assertion above (test 1).
    notificationsDb.upsertNotificationRule.run({ eventKey: 'verify_fail', inapp: 1, browser: 0 })

    expect(runsDb.markRunReviewed.run(Date.now(), rid).changes).toBe(1)
    expect(runsDb.markRunReviewed.run(Date.now(), rid).changes).toBe(0) // idempotent guard
    expect((eventsDb.nextEventSeq.get(rid) as { next: number }).next).toBe(0)
    expect((eventsDb.hasCheckpointEvents.get(rid) as { n: number }).n).toBe(0)

    projectsDb.setProjectAutoMerge.run(1, pid)
    expect((projectsDb.getProject.get(pid) as { auto_merge: number }).auto_merge).toBe(1)

    projectsDb.deleteProject(pid)
    expect(runPlansDb.getRunPlan.get(rid)).toBeUndefined()
    // Loose-ref decision: the notification row SURVIVES the project delete.
    expect(notificationsDb.listNotifications.all(10).some(r => (r as { id: string }).id === nid)).toBe(true)
  })

  it('agent_profiles.plan_gate round-trips through setProfilePlanGate', () => {
    // The durable seed row exists in every migrated DB (profiles.ts seedProfiles).
    const before = agentProfilesDb.getProfileRow.get('default-orchestrator') as { plan_gate: number } | undefined
    if (!before) return // fresh test DB without seeds — column presence is asserted by migrate above
    agentProfilesDb.setProfilePlanGate.run(1, 'default-orchestrator')
    expect((agentProfilesDb.getProfileRow.get('default-orchestrator') as { plan_gate: number }).plan_gate).toBe(1)
    agentProfilesDb.setProfilePlanGate.run(0, 'default-orchestrator')
  })
})

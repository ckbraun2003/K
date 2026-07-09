/**
 * P2 B2 — notify engine: transition dedupe, rules gating, channel semantics.
 * Real eventBus + real notifications table; zero spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Run, WsMessage } from '@k/shared'
import { db, notificationsDb, eventsDb, projectsDb, runsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { registerNotifications } from '../src/notify.js'

function makeRun(status: Run['status'], over: Partial<Run> = {}): Run {
  return { id: over.id ?? randomUUID(), prompt: 'notify me about this thing', cwd: 'C:\\n',
    status, provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1, ...over }
}

let dispose: (() => void) | null = null
let wsSeen: WsMessage[] = []
let unsubWs: (() => void) | null = null

beforeEach(() => {
  wsSeen = []
  unsubWs = eventBus.onBroadcast(m => { if (m.type === 'notification') wsSeen.push(m) })
  dispose = registerNotifications()
})
afterEach(() => {
  dispose?.(); unsubWs?.()
  // Delete exactly the rows THIS test fired: wsSeen carries every broadcast
  // notification (each inserted row is a subset), so this also catches the
  // verify_fail row a title/body string-match missed — no leak into the
  // shared-fork DB (the vitest-shared-data-dir hygiene gotcha).
  const firedIds: string[] = []
  for (const m of wsSeen) if (m.type === 'notification') firedIds.push(m.notification.id)
  if (firedIds.length > 0) {
    db.prepare(`DELETE FROM notifications WHERE id IN (${firedIds.map(() => '?').join(', ')})`).run(...firedIds)
  }
})

describe('registerNotifications', () => {
  it('fires run_awaiting_plan on the TRANSITION only (repeat emits dedupe)', () => {
    const run = makeRun('running')
    eventBus.emitRunUpdate(run)
    eventBus.emitRunUpdate({ ...run, status: 'awaiting_plan' })
    eventBus.emitRunUpdate({ ...run, status: 'awaiting_plan' }) // duplicate — no second fire
    const fired = wsSeen.filter(m => m.type === 'notification' && m.notification.runId === run.id)
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ browser: true, notification: { eventKey: 'run_awaiting_plan', title: 'Plan ready for review' } })
    // in-app row landed (rule inapp=1):
    const rows = notificationsDb.listNotifications.all(20) as Array<{ run_id: string | null; event_key: string }>
    expect(rows.some(r => r.run_id === run.id && r.event_key === 'run_awaiting_plan')).toBe(true)
  })

  it('re-park after resume fires again (running → awaiting_input → running → awaiting_input)', () => {
    const run = makeRun('running')
    eventBus.emitRunUpdate(run)
    eventBus.emitRunUpdate({ ...run, status: 'awaiting_input' })
    eventBus.emitRunUpdate({ ...run, status: 'running' })
    eventBus.emitRunUpdate({ ...run, status: 'awaiting_input' })
    expect(wsSeen.filter(m => m.notification.runId === run.id && m.notification.eventKey === 'run_awaiting_input')).toHaveLength(2)
  })

  it('run_review_ready needs done + projectId + a checkpoint event', () => {
    const bare = makeRun('running', { projectId: randomUUID() })
    eventBus.emitRunUpdate(bare)
    eventBus.emitRunUpdate({ ...bare, status: 'done' }) // no checkpoint events → silent
    expect(wsSeen.filter(m => m.notification.eventKey === 'run_review_ready')).toHaveLength(0)
    // FK (foreign_keys=ON): events.run_id → runs.id and runs.project_id → projects.id,
    // so the checkpoint event needs a real project+run to exist first (mirrors inbox-routes.test.ts).
    const ckPid = randomUUID()
    const ck = makeRun('running', { projectId: ckPid })
    projectsDb.insertProject.run({ id: ckPid, name: `notify-proj-${ckPid.slice(0, 8)}`, localPath: 'C:\\n',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: 1 })
    runsDb.insertRun.run({ ...ck, worktree: null })
    eventsDb.insertEvent.run({ id: randomUUID(), runId: ck.id, seq: 0, type: 'checkpoint', ts: 1,
      raw: '{}', text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
      toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null,
      childLabel: null, contextTokens: null })
    eventBus.emitRunUpdate(ck)
    eventBus.emitRunUpdate({ ...ck, status: 'done' })
    expect(wsSeen.filter(m => m.notification.runId === ck.id && m.notification.eventKey === 'run_review_ready')).toHaveLength(1)
    db.prepare('DELETE FROM events WHERE run_id = ?').run(ck.id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(ck.id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(ckPid)
  })

  it('verify_fail fires only on COMPLETED fail/error verify updates', () => {
    const rid = randomUUID()
    const base = { runId: rid, reason: null, commands: [], scope: null, startedAt: 1 }
    eventBus.broadcast({ type: 'verify_update', result: { ...base, status: 'running', completedAt: null } })
    eventBus.broadcast({ type: 'verify_update', result: { ...base, status: 'fail', completedAt: 2 } })
    eventBus.broadcast({ type: 'verify_update', result: { ...base, status: 'pass', completedAt: 3 } })
    const fired = wsSeen.filter(m => m.notification.eventKey === 'verify_fail' && m.notification.runId === rid)
    expect(fired).toHaveLength(1)
    expect(fired[0].browser).toBe(false) // seeded rule: inapp only
  })

  it('a fully-disabled rule silences BOTH channels (no row, no WS)', () => {
    const before = notificationsDb.getNotificationRule.get('run_failed') as { inapp: number; browser: number }
    notificationsDb.upsertNotificationRule.run({ eventKey: 'run_failed', inapp: 0, browser: 0 })
    try {
      const run = makeRun('running')
      eventBus.emitRunUpdate(run)
      eventBus.emitRunUpdate({ ...run, status: 'error' })
      expect(wsSeen.filter(m => m.notification.runId === run.id)).toHaveLength(0)
    } finally {
      notificationsDb.upsertNotificationRule.run({ eventKey: 'run_failed', inapp: before.inapp, browser: before.browser })
    }
  })
})

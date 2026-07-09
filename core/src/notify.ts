/**
 * E-19 notification engine (phase 1). Subscribes the SAME seams the verify engine
 * uses (run-verify.ts:171): run updates for the four run-shaped keys, broadcasts
 * for verify_update → verify_fail. Rules gate channels: an in-app row is written
 * only when rule.inapp; the WS member goes out when EITHER channel is on and
 * carries `browser` so the client knows to raise a browser Notification.
 *
 * Dedupe = STATUS TRANSITIONS (in-memory last-status map, pruned at terminal):
 * emitRunUpdate legitimately repeats a status (usage refreshes, session-capture
 * re-emits) and each repeat must not re-notify; a re-park after a resume is a
 * fresh transition and MUST notify again.
 */
import { randomUUID } from 'node:crypto'
import type { Notification, NotificationEventKey, Run, RunStatus, WsMessage } from '@k/shared'
import { eventBus } from './events.js'
import { eventsDb, notificationsDb } from './db.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

// Mirrors the SCHEMA_VERSION 10 seeds — a missing row can never crash or silence
// the engine differently than its seed.
const DEFAULT_RULES: Record<NotificationEventKey, { inapp: boolean; browser: boolean }> = {
  run_awaiting_input: { inapp: true, browser: true },
  run_awaiting_plan:  { inapp: true, browser: true },
  run_review_ready:   { inapp: true, browser: false },
  run_failed:         { inapp: true, browser: false },
  verify_fail:        { inapp: true, browser: false },
}

function ruleFor(key: NotificationEventKey): { inapp: boolean; browser: boolean } {
  const row = notificationsDb.getNotificationRule.get(key) as { inapp: number; browser: number } | undefined
  return row ? { inapp: row.inapp === 1, browser: row.browser === 1 } : DEFAULT_RULES[key]
}

function fire(key: NotificationEventKey, title: string, body: string | null, runId: string | null, projectId: string | null): void {
  const rule = ruleFor(key)
  if (!rule.inapp && !rule.browser) return
  const n: Notification = {
    id: randomUUID(), eventKey: key, title, body, runId, projectId,
    createdAt: Date.now(), readAt: null,
  }
  if (rule.inapp) {
    notificationsDb.insertNotification.run({ id: n.id, eventKey: n.eventKey, title: n.title,
      body: n.body, runId: n.runId, projectId: n.projectId, createdAt: n.createdAt, readAt: null })
  }
  eventBus.broadcast({ type: 'notification', notification: n, browser: rule.browser })
}

export function registerNotifications(): () => void {
  const lastStatus = new Map<string, RunStatus>()

  const offRun = eventBus.onRunUpdate((run: Run) => {
    const prev = lastStatus.get(run.id)
    if (prev === run.status) return
    if (isTerminalRunStatus(run.status)) lastStatus.delete(run.id) // prune — terminal runs never transition again
    else lastStatus.set(run.id, run.status)
    const body = run.prompt.split('\n')[0].slice(0, 80)
    const projectId = run.projectId ?? null
    if (run.status === 'awaiting_input') {
      fire('run_awaiting_input', 'Run needs your reply', body, run.id, projectId)
    } else if (run.status === 'awaiting_plan') {
      fire('run_awaiting_plan', 'Plan ready for review', body, run.id, projectId)
    } else if (run.status === 'error') {
      fire('run_failed', 'Run failed', body, run.id, projectId)
    } else if (run.status === 'done' && projectId != null
        && (eventsDb.hasCheckpointEvents.get(run.id) as { n: number }).n === 1) {
      fire('run_review_ready', 'Run ready for review', body, run.id, projectId)
    }
  })

  const offBroadcast = eventBus.onBroadcast((m: WsMessage) => {
    if (m.type !== 'verify_update') return
    if (m.result.completedAt == null) return
    if (m.result.status !== 'fail' && m.result.status !== 'error') return
    fire('verify_fail', 'Verification failed', `run ${m.result.runId.slice(0, 8)}`, m.result.runId, null)
  })

  return () => { offRun(); offBroadcast() }
}

/**
 * E-27 eval/verification-derived lessons. Deterministically groups REPEATED (>= MIN_FAILURES)
 * failures — failing verify_results — by a normalized signature and proposes ONE lesson per
 * signature through the EXISTING operator gate (agent_memory 'pending', D-041). Deduped (a
 * signature already represented by a pending lesson is skipped) and capped. The lesson text
 * carries a suggested charter adjustment; approval flows through the existing gate (no new UI).
 * Gated by enabled && proposals.
 *
 * Source note: TWO signals feed the gate — verify_results.reason (status='fail') and, since
 * v13 (P5-FU-5), eval_results.failure_reason (written by the eval runner sink:
 * eval/service.ts::deriveFailureReason — error string, else deterministic criticalFailures;
 * NULL for passes). Both flow through the same normalization/MIN_FAILURES/cap/dedupe. The
 * old "deferred until eval carries a reason" caveat is CLOSED.
 */
import { agentMemoryDb } from './db.js'
import { db } from './db.js'
import { randomUUID } from 'crypto'
import { schedule as cronSchedule } from 'node-cron'
import { autonomySettings } from './config-store.js'

export const MIN_FAILURES = 2
export const LESSON_PROPOSAL_CAP = 10

/** Normalize a failure reason to a stable signature (strip run-specific numbers/paths). */
function signature(reason: string): string {
  return reason.toLowerCase().replace(/\d+/g, '#').replace(/[a-z]:\\[^\s]+|\/[^\s]+/g, '<path>').slice(0, 120)
}

export function collectRepeatedFailures(now = Date.now()): Array<{ signature: string; count: number; text: string }> {
  const since = now - 30 * 86_400_000
  const rows = db.prepare(
    `SELECT reason FROM verify_results WHERE status = 'fail' AND completed_at >= ?`).all(since) as Array<{ reason: string | null }>
  // P5-FU-5: eval failures now carry a free-text reason too (v13 failure_reason,
  // written by the runner sink) — same normalization, same gate.
  const evalRows = db.prepare(
    `SELECT failure_reason AS reason FROM eval_results WHERE failure_reason IS NOT NULL AND createdAt >= ?`).all(since) as Array<{ reason: string | null }>
  const groups = new Map<string, { count: number; text: string }>()
  for (const r of [...rows, ...evalRows]) {
    if (!r.reason) continue
    const sig = signature(r.reason)
    const g = groups.get(sig) ?? { count: 0, text: r.reason }
    g.count++
    groups.set(sig, g)
  }
  return [...groups.entries()].filter(([, g]) => g.count >= MIN_FAILURES).map(([signature, g]) => ({ signature, count: g.count, text: g.text }))
}

export function proposeLessons(now = Date.now()): number {
  const s = autonomySettings()
  if (!s.enabled || !s.proposals) return 0
  const candidates = collectRepeatedFailures(now)
  let inserted = 0
  for (const c of candidates) {
    if (inserted >= LESSON_PROPOSAL_CAP) break
    // Dedupe on the bracketed signature token. Escape LIKE metacharacters (\ % _) in the
    // signature so a `%`/`_` carried in the failure reason can't wildcard-match a DIFFERENT
    // recurring signature. Match across ALL statuses (not just 'pending') so that once an
    // operator REJECTS a lesson for a signature, the hourly cron does not re-propose it.
    const escSig = c.signature.replace(/[\\%_]/g, '\\$&')
    const existing = db.prepare(
      `SELECT 1 FROM agent_memory WHERE lesson LIKE ? ESCAPE '\\' LIMIT 1`).get(`%[sig:${escSig}]%`)
    if (existing) continue
    const lesson = `Recurring failure (${c.count}×): ${c.text.slice(0, 200)}. Suggested charter adjustment: add a pre-flight check for this class before dispatch. [sig:${c.signature}]`
    // Reuse the EXISTING lesson writer (SEAMS contract) — a fleet-wide pending lesson (no run/profile).
    agentMemoryDb.insertLesson.run({ id: randomUUID(), runId: null, lesson, status: 'pending', createdAt: now, reviewedAt: null, profileId: null })
    inserted++
  }
  return inserted
}

export function startLessonProposals(opts?: { cron?: string }): () => void {
  if (process.env.LESSON_PROPOSALS === '0') return () => { /* disabled */ }
  const task = cronSchedule(opts?.cron ?? '0 * * * *', () => { try { proposeLessons() } catch (e) { console.warn('[lesson-proposals]', e) } })
  return () => task.stop()
}

// core/src/backlog-relay.ts
/**
 * E-15 backlog auto-pull — MAIN-process drain of the org backlog (open org-scoped
 * work_items). Opt-in (autonomySettings.enabled && backlogAutoPull), default OFF.
 * Mirrors lead-dispatch-relay: re-entrancy latch, per-row atomic CAS claim
 * (open→in_progress), unref'd interval. Respects maxConcurrency and the budget
 * governor (skips when at cap). Dispatches the OLDEST open item via startAgentRun
 * under the default orchestrator profile.
 */
import { db, proposalsDb, agentRunsDb } from './db.js'
import { startAgentRun } from './agent-runs.js'
import { autonomySettings } from './config-store.js'
import { budgetGate } from './budget-governor.js'

const DEFAULT_BACKLOG_INTERVAL_MS = 5_000
const PULL_PROFILE = 'default-orchestrator'
// Local prepare (routes/inbox.ts precedent) — re-open a claimed item whose dispatch threw,
// so the next tick retries it. db.ts's shared bundles stay W0-frozen.
const reopenBacklogItem = db.prepare(`UPDATE work_items SET status='open', run_id=NULL, updated_at=? WHERE id=?`)
let draining = false

/** Count in-flight auto-pulled runs = running activations of the pull profile. */
export function countRunningAutoPulls(): number {
  const rows = agentRunsDb.listAgentRunsByProfile.all(PULL_PROFILE) as Array<{ status: string }>
  return rows.filter(r => r.status === 'running').length
}

export async function drainBacklog(): Promise<number> {
  if (draining) return 0
  const s = autonomySettings()
  if (!s.enabled || !s.backlogAutoPull) return 0
  draining = true
  try {
    let dispatched = 0
    // Snapshot the base in-flight count ONCE: startAgentRun synchronously inserts a
    // 'running' agent_runs row for the pull profile, so a per-iteration
    // countRunningAutoPulls() would already include THIS drain's dispatches and adding
    // `+ dispatched` would double-count (under-filling concurrency for maxConcurrency>1).
    // baseRunning + dispatched is the true in-flight total.
    const baseRunning = countRunningAutoPulls()
    // Fill up to the concurrency headroom, one CAS-claimed item at a time.
    const rows = proposalsDb.listOpenBacklog.all(s.maxConcurrency * 2) as Array<Record<string, unknown>>
    for (const row of rows) {
      if (baseRunning + dispatched >= s.maxConcurrency) break
      const projectId = row.project_id != null ? String(row.project_id) : null
      if (!budgetGate({ projectId }).allowed) break // no headroom — leave it queued
      const id = String(row.id)
      // Atomic claim (status-only): only the drain that flips open→in_progress proceeds.
      if (proposalsDb.claimBacklogItem.run({ id, now: Date.now() }).changes === 0) continue
      try {
        const { runId } = await startAgentRun(PULL_PROFILE, {
          trigger: 'delegation', goal: String(row.title) + (row.body ? `\n\n${String(row.body)}` : ''),
          projectId: projectId ?? undefined,
        })
        proposalsDb.setWorkItemRun.run({ id, runId, now: Date.now() }) // record run id (W0.1)
        dispatched++
      } catch (err) {
        // startAgentRun rolled its own row back; re-open the item so it can be retried.
        reopenBacklogItem.run(Date.now(), id)
        console.warn(`[backlog-relay] pull ${id} failed:`, err)
      }
    }
    return dispatched
  } finally {
    draining = false
  }
}

export function startBacklogRelay(opts?: { intervalMs?: number }): () => void {
  if (process.env.BACKLOG_RELAY === '0') return () => { /* disabled */ }
  const intervalMs = opts?.intervalMs ?? (Number(process.env.BACKLOG_RELAY_INTERVAL_MS) || DEFAULT_BACKLOG_INTERVAL_MS)
  const timer = setInterval(() => { void drainBacklog().catch(() => { /* never crash the tick */ }) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

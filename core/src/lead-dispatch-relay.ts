/**
 * lead-dispatch-relay.ts — the MAIN-process drain for the Chief→lead dispatch queue (loop-b).
 *
 * WHY THIS EXISTS (the child→main decoupling)
 * -------------------------------------------
 * The mgmt `dispatch_lead` tool runs inside the ephemeral per-Chief-run stdio mgmt-server
 * CHILD process. If that tool dispatched the lead DIRECTLY (loop-a's shape), two things
 * would break the moment the Chief's turn ended and the child exited: the lead run's
 * `agent_runs` tracking row would stay 'running' forever (the run-lifecycle subscriber
 * that finalizes it dies with the child), and the lead→Chief report-back subscriber —
 * also wired in the child — would never fire. The lead run itself is a separate supervised
 * subprocess owned by the long-lived MAIN process, so it OUTLIVES the child that asked for
 * it, but its bookkeeping did not.
 *
 * The fix DECOUPLES recording the dispatch intent from executing it. `dispatch_lead` (in
 * the child) only RECORDS a 'pending' row in the DB-backed `lead_dispatches` queue. This
 * relay — started once in the MAIN process at boot (index.ts) — polls that queue and does
 * the actual EXECUTION here, where `startAgentRun`'s tracking-row lifecycle and the
 * report-back subscriber live in a process that stays up. The child and main are SEPARATE
 * processes sharing one SQLite DB file, so the hand-off MUST be DB-backed: an in-process
 * EventBus would not cross the process boundary.
 *
 * Mirrors chief-wake.ts's shape: an exported, directly-unit-testable body (drainLeadDispatches)
 * plus a start/stop wiring fn (startLeadDispatchRelay) with an env opt-out and an unref'd
 * interval so the loop never keeps the process alive.
 *
 * ── Concurrency + failure model ──────────────────────────────────────────────────
 *  • Re-entrancy guard: a module-level `draining` latch makes an overlapping drain a no-op
 *    (returns 0) so a slow drain and the next interval tick can't both run.
 *  • Atomic claim: each pending row is claimed via a conditional UPDATE (pending→dispatched);
 *    if `.changes === 0` another drain already claimed it, so it is skipped — an intent is
 *    executed exactly once.
 *  • Project scope (B1): the assignment's scope_projects names are resolved at EXECUTION
 *    time (resolveDispatchScope) — the FIRST name maps through the projects registry to the
 *    run's projectId + cwd, so the lead works in the scoped repo, not K's own. An
 *    unresolvable name or a missing localPath FAILS the dispatch cleanly (fail-closed:
 *    running a project-scoped objective in K's repo would silently violate operator intent),
 *    and a THROW during the resolution reads (post-claim) degrades through the same
 *    status-guarded mark-failed — the claimed intent is never stranded.
 *  • Partial-failure window: once startAgentRun succeeds the lead run is LIVE. The follow-up
 *    wiring (record lead_run_id, link the assignment, wire report-back) runs in an INNER
 *    try/catch so a wiring throw can NEVER propagate and lose the live run. If that wiring
 *    threw BEFORE the run id was recorded (setLeadDispatchRun itself), the intent would sit
 *    'dispatched' with lead_run_id NULL forever — the catch rescues it NOW (status-guarded
 *    mark-failed) instead of waiting for the boot sweep (reconcileOrphanedLeadDispatches).
 *  • Dispatch failure: startAgentRun rolls its own agent_runs row back to 'failed' and
 *    re-throws; the OUTER catch marks the intent 'failed' (leaving the assignment link NULL,
 *    so the Chief can retry) and degrades — a bad intent never crashes the loop.
 */

import fs from 'fs'
import { leadDispatchDb, mgmtDb } from './db.js'
import { startAgentRun } from './agent-runs.js'
import { reportLeadOutcomeToChief } from './chief-dispatch.js'
import { continueLeadOutcomeToK } from './k-thread.js'
import { getProjectByName } from './projects.js'
import { rowToAssignment } from './mcp/mgmt.js'

/** Default poll interval for the relay (ms). Overridable via env; read lazily inside
 *  startLeadDispatchRelay so it can be set after import (mirrors chief-wake's lazy reads). */
const DEFAULT_RELAY_INTERVAL_MS = 2_000

// Re-entrancy latch: true while a drain is in flight so an overlapping interval tick
// (or a manual call) is a no-op instead of racing the same pending rows.
let draining = false

export interface DispatchScope {
  projectId: string | null
  cwd?: string
  /** Set when the scope is unusable — the dispatch must FAIL (fail-closed). */
  error?: string
  /** Non-fatal note (e.g. multi-project pick) — logged, dispatch proceeds. */
  warning?: string
}

/** Resolve an assignment's scoped project names → the dispatch's project + cwd.
 *  Rules (B1): zero names → K-repo default (projectId null, cwd undefined — today's
 *  behavior); one or more names → the FIRST name is authoritative: it must resolve
 *  in the projects registry AND its localPath must exist on disk, else the dispatch
 *  fails cleanly (running a project-scoped objective in K's own repo would silently
 *  violate operator intent). Extra names beyond the first are ignored with a warning. */
export function resolveDispatchScope(projectNames: string[]): DispatchScope {
  if (projectNames.length === 0) return { projectId: null }
  const first = projectNames[0]
  const project = getProjectByName(first)
  if (!project) {
    return { projectId: null, error: `scoped project "${first}" not found in the projects registry` }
  }
  if (!fs.existsSync(project.localPath)) {
    return { projectId: null, error: `scoped project "${first}" localPath does not exist: ${project.localPath}` }
  }
  const warning =
    projectNames.length > 1
      ? `assignment scopes ${projectNames.length} projects — using the first ("${first}"); others ignored`
      : undefined
  return { projectId: project.id, cwd: project.localPath, warning }
}

/**
 * Drain the pending lead-dispatch queue: for each pending intent, atomically claim it
 * (pending→dispatched) then EXECUTE it here in the main process via startAgentRun. On a
 * successful dispatch, record the lead run id on the intent, link the Chief's assignment,
 * and wire the lead→Chief report-back. Never throws — a dispatch failure marks the intent
 * 'failed' and degrades. Returns the number of intents successfully dispatched.
 */
export async function drainLeadDispatches(): Promise<number> {
  if (draining) return 0
  draining = true
  try {
    const rows = leadDispatchDb.listPendingLeadDispatches.all() as Array<Record<string, unknown>>
    let dispatched = 0
    for (const row of rows) {
      const id = String(row.id)
      // Atomic claim: only the drain whose UPDATE actually flips pending→dispatched may
      // execute this intent. A concurrent/overlapping drain sees changes===0 and skips.
      if (leadDispatchDb.claimLeadDispatch.run({ id, dispatchedAt: Date.now() }).changes === 0) continue

      try {
        // Resolve the assignment's project scope (mgmt scope_projects — names → the
        // projects registry) at EXECUTION time, so the lead's worktree is created in the
        // scoped repo, not K's own. Unresolvable/missing-path scope fails the dispatch
        // cleanly (status-guarded mark-failed), never crashes the loop. This runs INSIDE
        // the try: the intent is already claimed 'dispatched', so a THROW here (e.g.
        // SQLITE_BUSY on the assignment/registry reads) must degrade through the same
        // catch below — never propagate and strand the row 'dispatched' with no run
        // until the boot-only reconcile.
        const assignmentRow = mgmtDb.getAssignment.get(String(row.assignment_id)) as Record<string, unknown> | undefined
        const scope = resolveDispatchScope(assignmentRow ? rowToAssignment(assignmentRow).projects : [])
        if (scope.error) {
          leadDispatchDb.markLeadDispatchFailed.run({ id, dispatchedAt: Date.now() })
          console.warn(`[lead-relay] dispatch ${id} failed: ${scope.error}`)
          continue
        }
        if (scope.warning) console.warn(`[lead-relay] dispatch ${id}: ${scope.warning}`)

        // Dispatch under the resolved lead profile in the MAIN process (its tracking-row
        // lifecycle + the report-back subscriber below outlive the mgmt-server child).
        const { runId } = await startAgentRun(String(row.lead_profile_id), {
          trigger: 'delegation',
          goal: String(row.goal),
          workflowId: String(row.workflow_id),
          projectId: scope.projectId ?? undefined,
          cwd: scope.cwd,
        })
        dispatched++

        // Partial-failure window: the lead run is now LIVE. A throw wiring up its
        // bookkeeping must NOT propagate/lose the run, so this is isolated.
        try {
          leadDispatchDb.setLeadDispatchRun.run({ id, leadRunId: runId })
          mgmtDb.setAssignmentLeadRun.run({ id: String(row.assignment_id), leadRunId: runId, updatedAt: Date.now() })
          if (row.chief_run_id != null) {
            // Two INDEPENDENT best-effort hops on the same lead terminal — the lead→Chief mgmt
            // report and the Chief→K continuation (loop-b2, no-op when the Chief woke
            // autonomously). Each is isolated so a (rare) synchronous throw wiring one never
            // silently skips the other.
            try {
              reportLeadOutcomeToChief(String(row.chief_run_id), runId, String(row.lead))
            } catch (reportErr) {
              console.warn(`[lead-relay] dispatch ${id}: lead→Chief report-back wiring failed:`, reportErr)
            }
            try {
              continueLeadOutcomeToK(String(row.chief_run_id), runId, String(row.lead))
            } catch (contErr) {
              console.warn(`[lead-relay] dispatch ${id}: Chief→K continuation wiring failed:`, contErr)
            }
          } else {
            console.warn(`[lead-relay] dispatch ${id}: no chief_run_id — lead→Chief report-back skipped`)
          }
        } catch (wireErr) {
          console.warn(`[lead-relay] dispatch ${id}: lead run ${runId} live but post-dispatch wiring failed:`, wireErr)
          // If the run id never got recorded on the intent (setLeadDispatchRun itself threw),
          // the row would sit 'dispatched' with lead_run_id NULL forever — the exact stranded
          // state the boot sweep (reconcileOrphanedLeadDispatches) exists to rescue. Rescue it
          // NOW instead (status-guarded mark-failed; assignment link stays NULL → retryable).
          // When the run id WAS recorded, the intent is complete — leave it 'dispatched'.
          try {
            const cur = leadDispatchDb.getLeadDispatch.get(id) as Record<string, unknown> | undefined
            if (cur && cur.lead_run_id == null) {
              leadDispatchDb.markLeadDispatchFailed.run({ id, dispatchedAt: Date.now() })
            }
          } catch { /* best-effort — never crash the drain */ }
        }
      } catch (err) {
        // startAgentRun threw (it already rolled its own agent_runs row back to
        // 'failed') — or the scope-resolution reads above did. Either way the intent is
        // claimed: mark it 'failed' (assignment link stays NULL → retryable) and degrade.
        leadDispatchDb.markLeadDispatchFailed.run({ id, dispatchedAt: Date.now() })
        console.warn(`[lead-relay] dispatch ${id} failed:`, err)
      }
    }
    return dispatched
  } finally {
    draining = false
  }
}

/**
 * Start the MAIN-process lead-dispatch relay: poll the pending queue on an interval and
 * drain it. Returns a stop fn that clears the interval (mirrors startChiefWake). Opt out
 * via LEAD_DISPATCH_RELAY=0 (returns a no-op stop, wiring nothing). The interval is unref'd
 * so the relay never keeps the process alive on its own.
 */
export function startLeadDispatchRelay(opts?: { intervalMs?: number }): () => void {
  if (process.env.LEAD_DISPATCH_RELAY === '0') return () => { /* disabled — nothing wired */ }

  const intervalMs = opts?.intervalMs ?? (Number(process.env.LEAD_DISPATCH_RELAY_INTERVAL_MS) || DEFAULT_RELAY_INTERVAL_MS)
  const timer = setInterval(() => { void drainLeadDispatches().catch(() => { /* never crash the tick */ }) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

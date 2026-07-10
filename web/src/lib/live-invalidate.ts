import type { QueryClient } from '@tanstack/react-query'
import type { RunStatus, WsMessage, SkillDraft } from '@k/shared'

/** The terminal run statuses (mirrors core's run-lifecycle) — a run in one of these
 *  will produce no further updates, so it is the settle point at which K-authored
 *  surfaces are refreshed (F-059). awaiting_input / running / queued are NON-terminal. */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['done', 'error', 'killed', 'interrupted'])

/**
 * Live run_update → react-query invalidation policy (wave C1), extracted from
 * ActivityStrip's inline handler so the wiring is unit-testable.
 *
 * On every `run_update` message:
 *  - ['runs'] and ['metrics'] are invalidated IMMEDIATELY, per message — preserving
 *    the pre-existing behavior. ['runs'] is a PREFIX, so it also matches the scoped
 *    default-list key (see runs-query.ts) and any future scoped siblings.
 *  - the K-home surface keys — ['k-thread'] (durable conversation), ['k-notes'],
 *    ['k-schedule'], ['k-work-items'] — are invalidated when the run reaches a TERMINAL
 *    status. A completed K/agent run both writes items (a note / work-item) and appends
 *    a k-turn (its reply / a Chief report-back), so K-authored changes surface live on
 *    K-home instead of only on the next reload (F-059). Gated on terminal (not every
 *    streaming tick) so a chatty run doesn't re-fetch these on each event.
 *  - the org keys — ['chief-org'] (Chief tree), ['orchestrators'] (roster), and the
 *    ['orchestrator'] prefix (every ['orchestrator', id] detail) — are invalidated
 *    THROTTLED: the leading edge fires immediately; further messages inside the
 *    `throttleMs` window coalesce into ONE trailing invalidation when the window
 *    closes. A chatty run streaming dozens of updates therefore can't stampede the
 *    (heavier) org refetches, but the FINAL state always lands via the trailing fire.
 *
 * Non-run_update messages are ignored. `dispose()` clears any pending trailing
 * timer — callers must invoke it on unmount so no invalidation fires afterwards.
 */
export function makeRunUpdateInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
  throttleMs = 250,
): { handler: (msg: WsMessage) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let trailingQueued = false

  const invalidateOrg = () => {
    void qc.invalidateQueries({ queryKey: ['chief-org'] })
    void qc.invalidateQueries({ queryKey: ['orchestrators'] })
    void qc.invalidateQueries({ queryKey: ['orchestrator'] })
  }

  const handler = (msg: WsMessage) => {
    if (msg.type !== 'run_update') return
    void qc.invalidateQueries({ queryKey: ['runs'] })
    void qc.invalidateQueries({ queryKey: ['metrics'] })
    // A run reaching TERMINAL may have written K-home surfaces (a completed K ask adds
    // a k-turn and can create notes / schedule entries / work-items). Refresh those
    // reads so K-authored items + replies appear live, not only on reload (F-059).
    if (TERMINAL_RUN_STATUSES.has(msg.run.status)) {
      void qc.invalidateQueries({ queryKey: ['k-thread'] })
      void qc.invalidateQueries({ queryKey: ['k-notes'] })
      void qc.invalidateQueries({ queryKey: ['k-schedule'] })
      void qc.invalidateQueries({ queryKey: ['k-work-items'] })
    }
    if (timer === null) {
      // Leading edge — invalidate now, then open the coalescing window.
      invalidateOrg()
      timer = setTimeout(() => {
        timer = null
        if (trailingQueued) {
          trailingQueued = false
          invalidateOrg()
        }
      }, throttleMs)
    } else {
      // Inside the window — fold into one trailing invalidation at window close.
      trailingQueued = true
    }
  }

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    trailingQueued = false
  }

  return { handler, dispose }
}

/**
 * Live projects-list invalidation (fix F-036). An externally-registered project —
 * one an agent (or another client) adds through the API/MCP, not this tab's
 * register dialog — never appeared until a manual reload, because the ['projects']
 * query has no live signal. The GitHub poller broadcasts a `github_update` for
 * every registered project (including a newly-registered one on its first poll),
 * so treating that as the projects-changed signal surfaces the new card live.
 *
 * Invalidates ['projects'] and ['github-fleet'] (the fleet-level cached github
 * batch behind the cards) on every `github_update`; all other messages are ignored.
 */
export function makeProjectListInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    if (msg.type !== 'github_update') return
    void qc.invalidateQueries({ queryKey: ['projects'] })
    void qc.invalidateQueries({ queryKey: ['github-fleet'] })
  }
}

/**
 * Live capability-catalog + skill-draft invalidation (wave C4).
 *
 *  - `capabilities_update` (a rescan completed / the enable overlay changed —
 *    possibly in another tab) → invalidate the ['capabilities'] PREFIX, so the
 *    catalog lists, the summary stat row and every CapabilityPicker refetch.
 *  - `run_update` reaching a TERMINAL status → if that run is a skill draft's
 *    authoring/refine run (matched against the cached ['skill-draft', id]
 *    details and the ['skill-drafts'] list), invalidate that draft + the list,
 *    so "drafting…" flips to ready/failed live instead of on manual reload.
 *    Cache-miss runs invalidate nothing — every other run stays zero-cost here.
 *
 * Non-matching messages are ignored. Reads ONLY the react-query cache (no
 * fetches of its own) — same composition pattern as the other invalidators.
 */
export function makeCapabilitiesInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries' | 'getQueriesData'>,
): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    if (msg.type === 'capabilities_update') {
      void qc.invalidateQueries({ queryKey: ['capabilities'] })
      return
    }
    if (msg.type !== 'run_update' || !TERMINAL_RUN_STATUSES.has(msg.run.status)) return
    const draftIds = new Set<string>()
    for (const [, detail] of qc.getQueriesData({ queryKey: ['skill-draft'] })) {
      const draft = detail as SkillDraft | undefined
      if (draft?.runId === msg.run.id) draftIds.add(draft.id)
    }
    for (const [, list] of qc.getQueriesData({ queryKey: ['skill-drafts'] })) {
      for (const draft of (list as SkillDraft[] | undefined) ?? []) {
        if (draft.runId === msg.run.id) draftIds.add(draft.id)
      }
    }
    for (const id of draftIds) {
      void qc.invalidateQueries({ queryKey: ['skill-draft', id] })
      // Draft evals ride the same authoring-run wire (an evaluate run landing
      // terminal finalizes an eval row).
      void qc.invalidateQueries({ queryKey: ['skill-draft-evals', id] })
    }
    if (draftIds.size > 0) void qc.invalidateQueries({ queryKey: ['skill-drafts'] })
  }
}

/** verify_update → refresh the one chip cache for that run. */
export function makeVerifyInvalidator(qc: QueryClient): (msg: WsMessage) => void {
  return (msg) => {
    if (msg.type !== 'verify_update') return
    void qc.invalidateQueries({ queryKey: ['run-verify', msg.result.runId] })
  }
}

/**
 * Live refresh on a task-workflow completion (F-076). When core broadcasts
 * `workflow_complete` (a finalized task-workflow, naming the tasks it locked to
 * in_progress), refresh the affected project's task list (['tasks', projectId]) and the
 * workflow-runs list so their state is live where the operator reviews + closes the tasks —
 * the harness never auto-closes them (D-012). A signal with no task ids (a lead workflow
 * run) and every non-workflow_complete message are ignored.
 */
export function makeWorkflowCompleteInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    if (msg.type !== 'workflow_complete' || msg.taskIds.length === 0) return
    void qc.invalidateQueries({ queryKey: ['tasks', msg.projectId] })
    void qc.invalidateQueries({ queryKey: ['workflow-runs'] })
  }
}

/** P2 E-05/E-19: any needs-YOU source may have changed → refresh the ONE inbox
 *  query (badge + page share it); a notification also refreshes the center. */
export function makeInboxInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    if (msg.type === 'run_update' || msg.type === 'notification' || msg.type === 'capabilities_update') {
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    }
    if (msg.type === 'notification') {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    }
  }
}

/**
 * P3 E-09: the Org Timeline feed reflects run lifecycle, notifications, and verify
 * results -- invalidate the ONE shared ['feed'] key on any of that traffic. Mirrors
 * makeInboxInvalidator; wired in KHome (the always-landing historical surface), NOT
 * in ActivityStrip (which stays on the live runs query). A ['feed'] prefix-key
 * invalidation also covers the timeline's ['feed', 500] entry.
 */
export function makeFeedInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    if (msg.type === 'run_update' || msg.type === 'notification' || msg.type === 'verify_update') {
      void qc.invalidateQueries({ queryKey: ['feed'] })
    }
  }
}

/**
 * chief-dispatch.ts — the Chief→lead DISPATCH seam (loop-a, P5.4).
 *
 * This is the downward mirror of k-thread.ts's K→Chief hop (delegateToChief +
 * reportDelegationBack + summarizeDelegatedOutcome + concatAssistantText). Where K
 * hands an ask UP to the Chief, the Chief hands an objective DOWN to an orchestrator
 * lead — seeding the lead's run prompt from a NamedWorkflow scaffold and wiring the
 * lead's terminal outcome back UP into the Chief's mgmt store.
 *
 * Like chief-wake.ts and mgmt.ts this module is SDK-free and unit-testable directly
 * against the DB + the run-lifecycle seam: it imports NO MCP/transport and NO
 * supervisor (the actual dispatch — startAgentRun — is invoked by the caller,
 * mgmt.ts::dispatchLead, so this file stays pure/seam helpers). The Chief→lead
 * parent→child link is derivable with NO new table: it is the lead run id recorded on
 * the Chief's durable assignment (`mgmt_assignments.lead_run_id`; parent =
 * `assignment.run_id`) plus the lead activation's `agent_runs.trigger='delegation'` —
 * exactly mirroring K→Chief's `k_thread_turns.run_id` + trigger.
 *
 * SCOPE (loop-a, mocked): this wave lands the DISPATCH + REPORT-BACK SEAMS, verified
 * in-process with a mocked supervisor. DEFERRED (loop-b / P5.6, and the conductor's
 * gated LIVE smoke): (1) running the dispatch on the long-lived MAIN process rather
 * than the ephemeral mgmt-server child, so lead supervision + this report-back outlive
 * the Chief's turn; (2) the Chief→K report continuation (re-surfacing the lead report
 * up to K); (3) the multi-tier org-tree DERIVATION render. The report filed here lands
 * in the Chief's mgmt store (inspectable + DB-derivable) — the continuation up to K is
 * loop-b.
 */

import { randomUUID } from 'crypto'
import type { AgentProfile } from '@k/shared'
import { getProfile, getProfileByName } from './profiles.js'
import { getWorkflowDef, getWorkflowDefByName } from './workflow-defs.js'
import { renderWorkflowPrompt, CODE_WAVE_SCAFFOLD } from './workflows.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { mgmtDb, eventsDb } from './db.js'

/** The default NamedWorkflow a lead dispatch seeds from when the assignment names no
 *  workflow choice (pick_workflow was never called). Matches the seeded code-wave id. */
export const DEFAULT_LEAD_WORKFLOW_ID = 'code-wave'

/** Max length of the lead's report-back answer, so a verbose lead run can't dump a
 *  huge raw transcript into the Chief's mgmt store (mirrors k-thread's cap). */
export const LEAD_REPORT_TEXT_CAP = 2_000

/** How many of the lead run's earliest `assistant` events the report-back scans (seq ASC)
 *  — enough to fill the 2k cap without materializing a long lead run's whole event log. */
const LEAD_REPORT_EVENT_SCAN = 50

/** The charter line appended to every dispatched lead's seed prompt: it tells the
 *  lead it is an orchestrator dispatched by the Chief and that it must OPEN A PR
 *  (never push to a default branch) when done. */
export const LEAD_CHARTER_LINE =
  'You are an orchestrator LEAD dispatched by the Chief. Deliver the objective as a single coordinated batch and OPEN A PULL REQUEST with the result when done (use the gh CLI: `gh pr create`). NEVER push to a default branch — branch off it first.'

type Row = Record<string, unknown>

/** True iff `p` is a dispatchable orchestrator LEAD — an orchestrator-tier profile
 *  that is NOT the generic default orchestrator (the durable discipline leads are all
 *  orchestrator-tier; discipline is a bundle+charter, not a tier — D-020). */
export function isLeadProfile(p: AgentProfile): boolean {
  return p.tier === 'orchestrator' && p.id !== 'default-orchestrator'
}

/**
 * Resolve an assignment's free-text `lead` (e.g. 'Frontend', 'lead-backend',
 * 'Backend lead') to a lead profile id, or null if none matches. Tries, in order:
 *   1. an exact profile id;
 *   2. an exact profile NAME;
 *   3. a normalized discipline slug → the `lead-<slug>` id.
 * Every hit is gated by isLeadProfile so a non-lead (K / Chief / default orchestrator)
 * can never be dispatched as a lead.
 */
export function resolveLeadProfileId(lead: string): string | null {
  const raw = lead.trim()

  const byId = getProfile(raw)
  if (byId && isLeadProfile(byId)) return byId.id

  const byName = getProfileByName(raw)
  if (byName && isLeadProfile(byName)) return byName.id

  const slug = raw
    .toLowerCase()
    .replace(/\s*lead$/, '')
    .replace(/^lead[-\s]*/, '')
    .trim()
  const bySlug = getProfile(`lead-${slug}`)
  if (bySlug && isLeadProfile(bySlug)) return bySlug.id

  return null
}

/**
 * Resolve the workflow to seed a lead dispatch from → its id + prompt scaffold. A
 * caller `choice` (the assignment's pick_workflow value) is resolved by id then name;
 * an absent/unresolvable choice falls back to the default code-wave workflow. If even
 * the default DB row is absent (workflow defs unseeded) it falls back to the built-in
 * CODE_WAVE_SCAFFOLD so a dispatch can always render a prompt.
 */
export function resolveLeadWorkflow(choice: string | null): { workflowId: string; scaffold: string } {
  if (choice) {
    const wf = getWorkflowDef(choice) ?? getWorkflowDefByName(choice)
    if (wf) return { workflowId: wf.id, scaffold: wf.promptScaffold }
    // A named-but-unresolvable choice degrades to the default rather than failing.
  }
  const def = getWorkflowDef(DEFAULT_LEAD_WORKFLOW_ID)
  if (def) return { workflowId: def.id, scaffold: def.promptScaffold }
  return { workflowId: DEFAULT_LEAD_WORKFLOW_ID, scaffold: CODE_WAVE_SCAFFOLD }
}

/** Seed a lead run's prompt: render the workflow scaffold with the objective as the
 *  single checklist item, then append the lead charter line. Pure + deterministic. */
export function buildLeadSeed(objective: string, scaffold: string): string {
  return `${renderWorkflowPrompt(scaffold, [{ title: objective }])}\n\n${LEAD_CHARTER_LINE}`
}

/** Concatenate a bounded prefix of a lead run's `assistant` event texts (oldest→newest,
 *  up to LEAD_REPORT_EVENT_SCAN events) then cap to LEAD_REPORT_TEXT_CAP — the report-back
 *  summary of the lead's own words. Mirrors k-thread.ts::concatAssistantText (a one-shot
 *  capped summary, not a stateful turn-by-turn capture). */
function concatLeadAssistantText(runId: string): string {
  const rows = eventsDb.listAssistantEvents.all(runId, LEAD_REPORT_EVENT_SCAN) as Row[]
  const parts: string[] = []
  for (const row of rows) {
    const text = row.text == null ? '' : String(row.text)
    if (text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n')
  return joined.length > LEAD_REPORT_TEXT_CAP ? `${joined.slice(0, LEAD_REPORT_TEXT_CAP)}…` : joined
}

/** Summarize a dispatched lead run's terminal outcome for the report filed UP to the
 *  Chief. Prefers the lead run's own assistant text; falls back to a bare status line
 *  when the lead produced no summary. */
export function summarizeLeadOutcome(leadRunId: string, status: string, lead: string): string {
  const verb = status === 'done' ? 'completed' : status
  const answer = concatLeadAssistantText(leadRunId)
  return answer.length > 0
    ? `Lead ${lead} (delegation ${verb}): ${answer}`
    : `Lead ${lead} delegation ${verb} — no summary was produced.`
}

/**
 * Report a dispatched lead run's outcome UP into the Chief's mgmt store — the downward
 * mirror of k-thread.ts::reportDelegationBack. Rides the shared run-lifecycle seam
 * (trackSupervisedRun): on the lead run's terminal — once, race-backstopped — it files
 * a mgmt report scoped to the Chief's run (run_id = chiefRunId), so the Chief's next
 * activation can read the lead's outcome from its own store. assignmentId is null: the
 * report is a status write up the chain, not itself an assignment.
 */
export function reportLeadOutcomeToChief(chiefRunId: string, leadRunId: string, lead: string): void {
  trackSupervisedRun(leadRunId, {
    onStarted: () => {
      /* runId already known — nothing to patch */
    },
    finalize: status => {
      mgmtDb.insertReport.run({
        id: randomUUID(),
        runId: chiefRunId,
        assignmentId: null,
        body: summarizeLeadOutcome(leadRunId, status, lead),
        createdAt: Date.now(),
      })
    },
  })
}

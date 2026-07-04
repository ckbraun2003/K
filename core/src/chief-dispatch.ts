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
import { getProfile, getProfileByName, listProfiles } from './profiles.js'
import { getWorkflowDef, getWorkflowDefByName } from './workflow-defs.js'
import { renderWorkflowPrompt, CODE_WAVE_SCAFFOLD, finalizeWorkflowRun } from './workflows.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { mgmtDb, eventsDb, workflowRunsDb, workflowStepsDb } from './db.js'

/** The default NamedWorkflow a lead dispatch seeds from when the assignment names no
 *  workflow choice (pick_workflow was never called). Matches the seeded code-wave id. */
export const DEFAULT_LEAD_WORKFLOW_ID = 'code-wave'

/** Max length of the lead's report-back answer, so a verbose lead run can't dump a
 *  huge raw transcript into the Chief's mgmt store (mirrors k-thread's cap). */
export const LEAD_REPORT_TEXT_CAP = 2_000


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

/** The dispatchable leads, in seed order — the ONE roster the `lead_list` mgmt tool, the
 *  assign-time validation, and the AUTO-path seed injection all derive from (so they can
 *  never name different sets). Each lead's discipline slug is its `lead-<slug>` id tail. */
export function listDispatchableLeads(): Array<{ id: string; name: string; discipline: string }> {
  return listProfiles()
    .filter(isLeadProfile)
    .map(p => ({
      id: p.id,
      name: p.name,
      discipline: p.id.startsWith('lead-') ? p.id.slice('lead-'.length) : p.name.toLowerCase(),
    }))
}

/** A one-line roster hint naming every dispatchable lead by name + id — injected into the
 *  Chief's AUTO-path seeds (wake goal / no-hint delegation) and the assign-time rejection
 *  message so the Chief always knows the VALID lead identifiers and never invents a
 *  discipline like "engineering" (F-067). Empty string when the roster is unseeded. */
export function leadRosterHint(): string {
  const leads = listDispatchableLeads()
  if (leads.length === 0) return ''
  const names = leads.map(l => `${l.name} (${l.id})`).join(', ')
  return (
    `Dispatchable leads: ${names}. Use the lead_list tool for the authoritative roster, then ` +
    `assign_lead with one of those names/ids (never an invented discipline).`
  )
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

/**
 * F-070: bind a dispatched lead run to a `workflow_runs` row + seed its checklist, so the
 * lead's kstore status-write tools RESOLVE (workflow_step_set / workflow_status_set no
 * longer return `not_in_workflow`) and it opens with a real checklist instead of improvising.
 *
 * `startAgentRun` records `workflow_id` on the agent_runs tracking row but never inserts a
 * `workflow_runs` row (only dispatchTaskWorkflow does), so kstore's resolveWorkflowRun found
 * nothing for a lead run. This creates that row (run_id = the lead run), seeds ONE 'pending'
 * step per role in the chosen NamedWorkflow (the checklist skeleton the lead then fills in),
 * and wires finalize on the lead's terminal (done→completed, else failed) via the shared
 * run-lifecycle seam — the same finalize that reconciles lingering steps (F-072).
 *
 * REQUIRES a real `projectId` (workflow_runs.project_id is NOT NULL) — the relay only calls
 * this for a project-scoped dispatch. Idempotent: a run that already has a workflow_run
 * reuses it. Returns the workflow_run id (or the existing one).
 */
export function seedLeadWorkflowRun(leadRunId: string, projectId: string, workflowId: string): string {
  const existing = workflowStepsDb.getWorkflowRunByRunId.get(leadRunId) as { id: string } | undefined
  if (existing) return existing.id

  const workflowRunId = randomUUID()
  const now = Date.now()
  workflowRunsDb.insertWorkflowRun.run({
    id: workflowRunId,
    projectId,
    runId: leadRunId,
    taskIds: '[]',
    mode: 'combined',
    workflowId,
    status: 'running',
    createdAt: now,
    completedAt: null,
  })

  // One checklist step per role in the NamedWorkflow (pending). A review role → kind
  // 'review'; every other role → 'phase'. The lead upserts these by label as it works.
  const def = getWorkflowDef(workflowId)
  if (def) {
    for (const role of def.roles) {
      const isReview = /review/i.test(role.id) || /review/i.test(role.label)
      workflowStepsDb.setWorkflowStep({
        id: randomUUID(),
        workflowRunId,
        label: role.label,
        kind: isReview ? 'review' : 'phase',
        workItemId: null,
        status: 'pending',
        detail: role.description ?? null,
        updatedAt: Date.now(),
      })
    }
  }

  // Finalize the lead's workflow_run when the lead run terminates (and reconcile lingering
  // steps — F-072), riding the same run-lifecycle seam as the report-back subscribers.
  trackSupervisedRun(leadRunId, {
    onStarted: () => {
      /* run id already known — nothing to patch */
    },
    finalize: status => finalizeWorkflowRun(workflowRunId, status),
  })

  return workflowRunId
}

/** The lead run's CONCLUSION — its final (last) non-empty `assistant` event text, capped
 *  to LEAD_REPORT_TEXT_CAP. F-075: the report-back is the lead's actual conclusion (the
 *  TAIL, e.g. "Opened PR #7; CI green."), NOT a truncated PREFIX of the opening turns
 *  ("I'll start by loading the workflow status tools…"). */
function finalLeadAssistantText(runId: string): string {
  const row = eventsDb.latestAssistantEvent.get(runId) as Row | undefined
  const text = row?.text == null ? '' : String(row.text)
  return text.length > LEAD_REPORT_TEXT_CAP ? `${text.slice(0, LEAD_REPORT_TEXT_CAP)}…` : text
}

/** Summarize a dispatched lead run's terminal outcome for the report filed UP to the
 *  Chief. F-075: prefers a CONCISE signal — the lead's own mgmt `report` (report_list) when
 *  it filed one — mirroring k-thread.ts::summarizeDelegatedOutcome; else the lead's
 *  CONCLUSION (final assistant message, not the prefix); else a bare status line. */
export function summarizeLeadOutcome(leadRunId: string, status: string, lead: string): string {
  const verb = status === 'done' ? 'completed' : status
  // Prefer the lead's explicit mgmt report (a concise status write) over raw transcript.
  const reports = mgmtDb.listReportsByRun.all(leadRunId, 1) as Row[]
  const reportBody = reports.length > 0 ? String(reports[0].body) : ''
  if (reportBody.length > 0) {
    const capped =
      reportBody.length > LEAD_REPORT_TEXT_CAP ? `${reportBody.slice(0, LEAD_REPORT_TEXT_CAP)}…` : reportBody
    return `Lead ${lead} (delegation ${verb}) reported: ${capped}`
  }
  const answer = finalLeadAssistantText(leadRunId)
  return answer.length > 0
    ? `Lead ${lead} (delegation ${verb}): ${answer}`
    : `Lead ${lead} delegation ${verb} — no summary was produced.`
}

/**
 * Report a dispatched lead run's outcome UP into the Chief's mgmt store — the downward
 * mirror of k-thread.ts::reportDelegationBack. Rides the shared run-lifecycle seam
 * (trackSupervisedRun): on the lead run's terminal — once, race-backstopped — it files
 * a mgmt report with run_id = chiefRunId (provenance). The Chief's NEXT activation reads
 * it via the cross-activation mgmt read tools (report_list / assignment_list) — those
 * reads are durable, NOT run-scoped, so a later Chief wake sees this lead's outcome even
 * though it ran under a different run. assignmentId is null: the report is a status write
 * up the chain, not itself an assignment.
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

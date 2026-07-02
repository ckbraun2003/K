import type {
  ChiefOrgPayload,
  ChiefOrgLead,
  DelegationNode,
  DelegationNodeStatus,
} from '@k/shared'
import { eventsToWorkflowTree, type WorkflowChild } from './workflow'

/**
 * Pure builder for the Chief delegation tree (P5.2a): Chief → leads → each lead's
 * sub-agents.
 *
 * A lead's sub-agents are exactly its most-recent run's `delegate` tool calls, so
 * we REUSE the Workflows-view builder (eventsToWorkflowTree) unchanged for that
 * level rather than re-deriving delegate pairing. Like that builder this NEVER
 * throws on missing/empty data, and uses `??` (not `||`) so an explicitly-empty
 * value stays distinct from an unset one.
 *
 * The output is the generic @k/shared `DelegationNode` view type, so the
 * DelegationTree component can render a whole-org root here OR a single-lead root
 * (leadNode) in P5.3.
 */

/** Collapse a raw RunStatus to the tree's colour states. running/awaiting_input →
 *  running; queued stays queued; done → done; error/killed/interrupted → error;
 *  anything else (unknown) → idle. */
function runStatusToDelegationStatus(status: string): DelegationNodeStatus {
  switch (status) {
    case 'running':
    case 'awaiting_input':
      return 'running'
    case 'queued':
      return 'queued'
    case 'done':
      return 'done'
    case 'error':
    case 'killed':
    case 'interrupted':
      return 'error'
    default:
      return 'idle'
  }
}

/** Short, single-line label for the inspector meta (trimmed + capped). */
function shortLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** One delegated sub-agent (a WorkflowChild) → a leaf DelegationNode. In K,
 *  delegated agents run in-process one level deep, so sub-agents are leaves here. */
function subAgentNode(child: WorkflowChild): DelegationNode {
  return {
    id: child.id,
    // agentType is the sub-agent kind (e.g. "implementer"); label is its human name.
    label: child.agentType,
    kind: 'sub-agent',
    status: child.status, // WorkflowNodeStatus ⊂ DelegationNodeStatus (running|done|error)
    meta: child.label ?? undefined,
    children: [],
  }
}

/**
 * Build a single lead's DelegationNode: the lead + its sub-agents (from its latest
 * run's events). Exported so P5.3 can render a single-lead tree from the same shape.
 */
export function leadNode(lead: ChiefOrgLead): DelegationNode {
  const { profile, latestRun, events, wakes } = lead
  const children = eventsToWorkflowTree(events ?? [], latestRun ?? undefined).children.map(subAgentNode)
  const status: DelegationNodeStatus = latestRun
    ? runStatusToDelegationStatus(latestRun.status)
    : 'idle'
  const meta = latestRun
    ? shortLine(latestRun.prompt)
    : (wakes?.length ?? 0) > 0
      ? `${wakes.length} wake${wakes.length === 1 ? '' : 's'}`
      : 'no runs yet'
  return {
    id: profile.id,
    label: profile.name,
    kind: 'lead',
    status,
    meta,
    // The run backing the node — lets the inspector offer "View run"/"Stop run".
    runId: latestRun?.id,
    children,
  }
}

/**
 * Build the whole-org DelegationNode root: Chief → each lead → its sub-agents.
 * The Chief's status reflects its own wake history (running when any wake is live).
 */
export function orgToDelegationTree(payload: ChiefOrgPayload): DelegationNode {
  const leads = payload.leads ?? []
  const chiefWakes = payload.chiefWakes ?? []
  const children = leads.map(leadNode)
  const chiefRunning = chiefWakes.some(w => w.status === 'running')
  // Active-leads count: SERVER-AUTHORITATIVE (routes/chief.ts computes leadsActive
  // from the same scan that built `leads`, and surfaces it top-level + in health).
  // The old client-side re-derivation over `children` statuses is gone — two
  // computations of the same fact can only drift.
  const activeLeads = payload.leadsActive ?? payload.health?.leadsActive ?? 0
  return {
    id: 'chief',
    label: payload.chief?.name ?? 'Chief',
    kind: 'chief',
    status: chiefRunning ? 'running' : 'idle',
    // The newest chiefWake that reached a run (live OR terminal) — "View run" is a
    // history jump, not a liveness claim.
    runId: chiefWakes.find(w => w.runId != null)?.runId ?? undefined,
    meta: `${children.length} lead${children.length === 1 ? '' : 's'} · ${activeLeads} active`,
    children,
  }
}

/**
 * Build the WHOLE-ORG DelegationNode root (loop-b2): user → K → Chief → each lead → its
 * sub-agents. Wraps orgToDelegationTree (the Chief subtree, unchanged) under the two
 * ancestor tiers the full chain needs to be VISIBLE (§13). The tiers are DERIVED from the
 * delegation links, not stored: the Chief subtree from run events + delegate pairs, and the
 * K-tier edge from `payload.kDelegations` (chief activations with trigger='delegation' — the
 * count of times K handed work up to the Chief). K's status reflects the chain below it
 * (running while the Chief subtree is active); the user root is the operator anchor. NEVER
 * throws on missing data — an absent kDelegations defaults to 0.
 */
export function fullOrgToDelegationTree(payload: ChiefOrgPayload): DelegationNode {
  const chief = orgToDelegationTree(payload)
  const kDelegations = payload.kDelegations ?? 0
  // K rides the chain: active while the Chief OR any lead below it is live — crucially
  // including the loop-b2 window where the Chief's own activation has finalized but a lead
  // it dispatched is still running (chief.status only reflects Chief wakes, so fold in the
  // lead children too). The user root is a static operator anchor (always idle).
  const subtreeActive =
    chief.status === 'running' ||
    chief.children.some(c => c.status === 'running' || c.status === 'queued')
  const kNode: DelegationNode = {
    id: 'k',
    label: 'K',
    kind: 'secretary',
    status: subtreeActive ? 'running' : 'idle',
    meta: `secretary front door · ${kDelegations} delegation${kDelegations === 1 ? '' : 's'} to Chief`,
    children: [chief],
  }
  return {
    id: 'user',
    label: 'Operator',
    kind: 'user',
    status: 'idle',
    meta: 'the front door → the whole org',
    children: [kNode],
  }
}

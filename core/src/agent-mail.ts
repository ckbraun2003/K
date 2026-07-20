/**
 * agent-mail.ts — the agent mailbox store + delivery rules + tier gate
 * (Continuous Agents B.1, D-124).
 *
 * Three pieces, all SDK-free and directly unit-testable:
 *  - queueMessage: the validated insert over the W0 agentMessagesDb helpers. It is
 *    deliberately UNGATED — mayMessage gates the BOUNDARIES (the message_agent MCP
 *    tool, the user HTTP route); harness-initiated sends (B.4 report-backs, Lane C
 *    supervision briefings) are pre-authorized by construction and include pairs the
 *    tier matrix does not grant (a lead reporting UP to K).
 *  - resolveDelivery: the PURE state × priority matrix the relay executes. 'interrupt'
 *    is the urgent+mid-turn cell; the relay executes it as ONE control-protocol
 *    interrupt nudge (supervisor.sendInterrupt, INT.4) + boundary delivery — the
 *    nudge only ever accelerates the boundary, never replaces it.
 *  - mayMessage: the tier-gate matrix as a deterministic function of DB state
 *    (agent_profiles.tier/domain_id, domains.manager_profile_id, pipeline ownership).
 *
 * Import discipline: db.js + @k/shared ONLY. k-thread.ts (B.4) imports this module,
 * and agent-sessions.ts imports k-thread.ts — importing agent-sessions from here
 * would close an ESM cycle the codebase deliberately avoids. Callers resolve default
 * conversations themselves (getOrCreateConversation lives in agent-sessions).
 */
import { randomUUID } from 'crypto'
import type { AgentMessage } from '@k/shared'
import { db, agentMessagesDb } from './db.js'

/** Who a message is from — mirrors agent-sessions.ts::MessageFrom (kept structurally
 *  identical; not imported, see the import-discipline note above). */
export type MailFrom = { kind: 'user' } | { kind: 'profile'; profileId: string }

/** Thrown for caller errors (unknown target/thread, empty body); boundaries map it
 *  to a clean 400 / tool error. */
export class AgentMailError extends Error {}

/** The canonical K profile id — mirrored from agent-sessions.ts (module-local there;
 *  importing it would close the cycle this module's import discipline avoids). */
const K_SECRETARY_PROFILE_ID = 'k-secretary'

type Row = Record<string, unknown>

// ── local prepared statements (the frozen W0 db bundles stay untouched) ──────
const getProfileTierDomain = db.prepare(`SELECT tier, domain_id FROM agent_profiles WHERE id = ?`)
const getThreadOwner = db.prepare(`SELECT profile_id FROM k_threads WHERE id = ?`)
const getMessage = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`)
const managerOfDomain = db.prepare(`SELECT manager_profile_id FROM domains WHERE id = ?`)
const managesDomainOf = db.prepare(
  `SELECT 1 AS hit FROM domains d JOIN agent_profiles p ON p.domain_id = d.id
   WHERE d.manager_profile_id = ? AND p.id = ?
   LIMIT 1`,
)
// "Its running stages": the target profile is the ACTOR of a non-terminal agent stage
// in a pipeline the sender OWNS. dispatched/running are the live statuses; a terminal
// or pending stage is not a running conversation partner.
const targetRunsSendersStage = db.prepare(
  `SELECT 1 AS hit FROM pipeline_stages ps JOIN pipeline_runs pr ON ps.pipeline_run_id = pr.id
   WHERE pr.owner_profile_id = ? AND ps.profile_id = ? AND ps.kind = 'agent'
     AND ps.status IN ('dispatched','running')
   LIMIT 1`,
)

// ── row mapper ────────────────────────────────────────────────────────────────

/** agent_messages row (snake_case) → the shared AgentMessage shape. Exported as the
 *  one mapping authority (relay + routes reuse it). */
export function rowToAgentMessage(r: Row): AgentMessage {
  return {
    id: String(r.id),
    toProfileId: String(r.to_profile_id),
    toThreadId: r.to_thread_id == null ? null : String(r.to_thread_id),
    fromKind: r.from_kind as AgentMessage['fromKind'],
    fromProfileId: r.from_profile_id == null ? null : String(r.from_profile_id),
    body: String(r.body),
    priority: r.priority as AgentMessage['priority'],
    status: r.status as AgentMessage['status'],
    provenanceRunId: r.provenance_run_id == null ? null : String(r.provenance_run_id),
    createdAt: Number(r.created_at),
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
  }
}

// ── delivery matrix (pure) ────────────────────────────────────────────────────

export type DeliveryDecision = 'stdin-now' | 'boundary' | 'wake' | 'interrupt'

/** The relay's view of the target session at delivery time: the session-row state
 *  plus whether the attached live run is mid-turn (NOT parked awaiting_input). */
export interface DeliverySessionView {
  state: 'live' | 'resumable' | 'stale'
  midTurn: boolean
}

/**
 * The delivery matrix (design §Mailbox + steering):
 *   live + parked        → 'stdin-now'  (inject via supervisor.sendInput)
 *   live + mid-turn      → 'boundary'   (normal) | 'interrupt' (urgent)
 *   resumable/stale      → 'wake'       (spawn/resume with the queued batch)
 * INT.4: the relay executes 'interrupt' as one sendInterrupt nudge (SDK
 * control_request — the CLI aborts its turn early and parks) with the rows left
 * queued for the boundary's 'stdin-now' cell; a CLI that ignores the nudge just
 * delivers at its natural boundary (the documented degradation, built-in).
 */
export function resolveDelivery(
  session: DeliverySessionView,
  message: Pick<AgentMessage, 'priority'>,
): DeliveryDecision {
  if (session.state !== 'live') return 'wake'
  if (!session.midTurn) return 'stdin-now'
  return message.priority === 'urgent' ? 'interrupt' : 'boundary'
}

// ── tier gate (pure over DB state) ───────────────────────────────────────────

/**
 * May `from` message the profile `toProfileId`? The tier matrix (design §Mailbox):
 *   user         → anyone
 *   K (secretary)→ anyone (but never itself — wake-loop guard)
 *   manager      → K + agents whose domain_id names a domain the sender manages
 *   orchestrator → its domain's manager + profiles running its pipeline stages
 *   workers      → nobody (worker sub-agents have no profile row → unknown sender)
 * Deterministic over DB state, no side effects. Target existence is the CALLER's
 * check (queueMessage / the tool both validate it with a typed error).
 */
export function mayMessage(from: MailFrom, toProfileId: string): boolean {
  if (from.kind === 'user') return true
  if (from.profileId === toProfileId) return false // self-send: never (loop guard)
  const sender = getProfileTierDomain.get(from.profileId) as
    | { tier?: string; domain_id?: string | null }
    | undefined
  if (!sender) return false // no profile row (workers/unknown) → nobody
  if (sender.tier === 'secretary') return true
  if (sender.tier === 'chief') {
    if (toProfileId === K_SECRETARY_PROFILE_ID) return true
    return managesDomainOf.get(from.profileId, toProfileId) !== undefined
  }
  if (sender.tier === 'orchestrator') {
    if (sender.domain_id != null) {
      const mgr = managerOfDomain.get(String(sender.domain_id)) as
        | { manager_profile_id?: string | null }
        | undefined
      if (mgr?.manager_profile_id != null && String(mgr.manager_profile_id) === toProfileId) return true
    }
    return targetRunsSendersStage.get(from.profileId, toProfileId) !== undefined
  }
  return false
}

// ── queueMessage ──────────────────────────────────────────────────────────────

export interface QueueMessageInput {
  toProfileId: string
  /** The target conversation. Callers SHOULD resolve it (tool/route/report-backs all
   *  do) so unread counts and relay grouping are exact; NULL is legal and resolved by
   *  the relay at delivery time. When given it must exist AND be owned by the target
   *  profile (pairing validation — the W0.3 ledger checklist item). */
  toThreadId?: string | null
  from: MailFrom
  body: string
  priority?: 'normal' | 'urgent'
  provenanceRunId?: string | null
}

/** Validate + insert one queued message. Returns the stored AgentMessage. */
export function queueMessage(input: QueueMessageInput): AgentMessage {
  // trim() so a whitespace-only body is rejected too — it would otherwise deliver
  // as a blank steering block. The STORED body stays verbatim (no silent rewrite).
  if (!input.body || input.body.trim().length === 0) {
    throw new AgentMailError('message body must be non-empty')
  }
  if (!getProfileTierDomain.get(input.toProfileId)) {
    throw new AgentMailError(`unknown target profile "${input.toProfileId}"`)
  }
  if (input.toThreadId != null) {
    const owner = getThreadOwner.get(input.toThreadId) as { profile_id?: string } | undefined
    if (!owner) throw new AgentMailError(`unknown thread "${input.toThreadId}"`)
    if (String(owner.profile_id) !== input.toProfileId) {
      throw new AgentMailError(
        `thread "${input.toThreadId}" is not owned by profile "${input.toProfileId}"`,
      )
    }
  }
  const id = randomUUID()
  agentMessagesDb.insert.run({
    id,
    toProfileId: input.toProfileId,
    toThreadId: input.toThreadId ?? null,
    fromKind: input.from.kind,
    fromProfileId: input.from.kind === 'profile' ? input.from.profileId : null,
    body: input.body,
    priority: input.priority ?? 'normal',
    provenanceRunId: input.provenanceRunId ?? null,
    createdAt: Date.now(),
  })
  return rowToAgentMessage(getMessage.get(id) as Row)
}

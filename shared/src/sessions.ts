import { z } from 'zod'

// ─── Continuous Agents (W0.2) — session / message / domain contracts ─────────
// Persistent per-(profile,thread) agent sessions, the inter-agent message queue,
// and operator-defined domains. Re-exported from types.ts (the package index —
// this package has no index.ts; its main is dist/types.js).

// Session lifecycle: 'live' = a process is attached (stdin open); 'resumable' =
// process dead but the CLI session can be --resumed; 'stale' = not worth resuming.
export const SessionStateSchema = z.enum(['live', 'resumable', 'stale'])
export type SessionState = z.infer<typeof SessionStateSchema>

// What kind of work a run represents (runs.kind, DB v16 backfilled).
export const RunKindSchema = z.enum(['chat-turn', 'job', 'pipeline-stage'])
export type RunKind = z.infer<typeof RunKindSchema>

export const MessagePrioritySchema = z.enum(['normal', 'urgent'])
export type MessagePriority = z.infer<typeof MessagePrioritySchema>

// Org role an agent plays: 'primary' (secretary), 'manager' (chief),
// 'orchestrator' (discipline lead). Mapped from profile tier via roleForTier.
export const AgentRoleSchema = z.enum(['primary', 'manager', 'orchestrator'])
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const AgentSessionSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  threadId: z.string(),
  cliSessionId: z.string().nullable(),
  homeDir: z.string(),
  state: SessionStateSchema,
  contextTokens: z.number().nullable(),
  lastActivityAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AgentSession = z.infer<typeof AgentSessionSchema>

export const AgentMessageSchema = z.object({
  id: z.string(),
  toProfileId: z.string(),
  toThreadId: z.string().nullable(),
  fromKind: z.enum(['user', 'profile']),
  fromProfileId: z.string().nullable(),
  body: z.string(),
  priority: MessagePrioritySchema,
  status: z.enum(['queued', 'delivered', 'failed']),
  provenanceRunId: z.string().nullable(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const DomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  managerProfileId: z.string().nullable(),
  createdAt: z.number(),
})
export type Domain = z.infer<typeof DomainSchema>

/** Profile tier → org role. secretary→primary, chief→manager, orchestrator→orchestrator. */
export function roleForTier(tier: 'secretary' | 'chief' | 'orchestrator'): z.infer<typeof AgentRoleSchema> {
  return tier === 'secretary' ? 'primary' : tier === 'chief' ? 'manager' : 'orchestrator'
}

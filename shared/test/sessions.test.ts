import { describe, expect, test } from 'vitest'
import {
  SessionStateSchema,
  RunKindSchema,
  MessagePrioritySchema,
  AgentRoleSchema,
  AgentSessionSchema,
  AgentMessageSchema,
  DomainSchema,
  roleForTier,
} from '../src/types'

// Task W0.2 (continuous-agents) — session/message/domain contracts + role map.
// Imports via ../src/types (not ../src/sessions) deliberately: the package has no
// index.ts — types.ts IS the index — so this also proves the re-export line works.

describe('roleForTier', () => {
  test('maps all three tiers exactly', () => {
    expect(roleForTier('secretary')).toBe('primary')
    expect(roleForTier('chief')).toBe('manager')
    expect(roleForTier('orchestrator')).toBe('orchestrator')
  })
})

describe('enum schemas', () => {
  test('SessionStateSchema accepts live/resumable/stale, rejects warm', () => {
    for (const v of ['live', 'resumable', 'stale']) expect(SessionStateSchema.safeParse(v).success).toBe(true)
    expect(SessionStateSchema.safeParse('warm').success).toBe(false)
  })

  test('RunKindSchema accepts chat-turn/job/pipeline-stage, rejects turn', () => {
    for (const v of ['chat-turn', 'job', 'pipeline-stage']) expect(RunKindSchema.safeParse(v).success).toBe(true)
    expect(RunKindSchema.safeParse('turn').success).toBe(false)
  })

  test('MessagePrioritySchema accepts normal/urgent, rejects high', () => {
    for (const v of ['normal', 'urgent']) expect(MessagePrioritySchema.safeParse(v).success).toBe(true)
    expect(MessagePrioritySchema.safeParse('high').success).toBe(false)
  })

  test('AgentRoleSchema accepts primary/manager/orchestrator, rejects lead', () => {
    for (const v of ['primary', 'manager', 'orchestrator']) expect(AgentRoleSchema.safeParse(v).success).toBe(true)
    expect(AgentRoleSchema.safeParse('lead').success).toBe(false)
  })
})

describe('AgentSessionSchema', () => {
  const valid = {
    id: 'sess-1', profileId: 'k-secretary', threadId: 'thread-1', cliSessionId: 'cli-abc',
    homeDir: '/data/homes/k-secretary', state: 'live', contextTokens: 12345,
    lastActivityAt: 1_700_000_000_000, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001,
  }

  test('accepts a fully-valid session', () => {
    expect(AgentSessionSchema.safeParse(valid).success).toBe(true)
  })

  test('nullable fields accept null', () => {
    const r = AgentSessionSchema.safeParse({ ...valid, cliSessionId: null, contextTokens: null, lastActivityAt: null })
    expect(r.success).toBe(true)
  })

  test("rejects state:'warm'", () => {
    expect(AgentSessionSchema.safeParse({ ...valid, state: 'warm' }).success).toBe(false)
  })
})

describe('AgentMessageSchema', () => {
  const valid = {
    id: 'msg-1', toProfileId: 'chief', toThreadId: 'thread-1', fromKind: 'user',
    fromProfileId: null, body: 'status?', priority: 'normal', status: 'queued',
    provenanceRunId: null, createdAt: 1_700_000_000_000, deliveredAt: null,
  }

  test('accepts a fully-valid message (nullables as null, incl. toThreadId)', () => {
    expect(AgentMessageSchema.safeParse({ ...valid, toThreadId: null }).success).toBe(true)
  })

  test("accepts status:'failed'", () => {
    expect(AgentMessageSchema.safeParse({ ...valid, status: 'failed' }).success).toBe(true)
  })

  test("rejects status:'pending'", () => {
    expect(AgentMessageSchema.safeParse({ ...valid, status: 'pending' }).success).toBe(false)
  })

  test('accepts a profile-sent delivered message (nullables populated)', () => {
    const r = AgentMessageSchema.safeParse({
      ...valid, fromKind: 'profile', fromProfileId: 'k-secretary', status: 'delivered',
      provenanceRunId: 'run-1', deliveredAt: 1_700_000_000_002,
    })
    expect(r.success).toBe(true)
  })

  test("rejects priority:'high'", () => {
    expect(AgentMessageSchema.safeParse({ ...valid, priority: 'high' }).success).toBe(false)
  })

  test("rejects fromKind:'system'", () => {
    expect(AgentMessageSchema.safeParse({ ...valid, fromKind: 'system' }).success).toBe(false)
  })
})

describe('DomainSchema', () => {
  test('accepts a fully-valid domain', () => {
    const r = DomainSchema.safeParse({
      id: 'engineering', name: 'Engineering', description: 'builds things',
      managerProfileId: 'chief', createdAt: 1_700_000_000_000,
    })
    expect(r.success).toBe(true)
  })

  test('nullable fields accept null', () => {
    const r = DomainSchema.safeParse({
      id: 'engineering', name: 'Engineering', description: null, managerProfileId: null,
      createdAt: 1_700_000_000_000,
    })
    expect(r.success).toBe(true)
  })

  test('rejects a null name (only description/managerProfileId are nullable)', () => {
    const r = DomainSchema.safeParse({
      id: 'engineering', name: null, description: null, managerProfileId: null,
      createdAt: 1_700_000_000_000,
    })
    expect(r.success).toBe(false)
  })
})

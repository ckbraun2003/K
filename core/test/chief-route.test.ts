/**
 * Chief org-status route test — GET /api/chief/org (P5.2a).
 *
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it
 * with app.inject — no socket, no scheduler. DB is isolated via vitest.config.ts
 * K_DATA_DIR. Bootstrap is skipped via K_SKIP_BOOTSTRAP (buildApp does NOT seed
 * profiles), so the test seeds the durable org roster itself before hitting the
 * route, then asserts the ONE batched payload's shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, mgmtDb, runsDb, agentRunsDb, eventsDb } from '../src/db.js'
import { seedProfiles } from '../src/profiles.js'
import type { ChiefOrgPayload } from '@k/shared'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const ASSIGNMENT_ID = uuid()
// A populated Backend-lead run (agent_run → run → delegate call + result events) so
// the route's latestRun assembly + rowToAgentEvent + the delegate-events query are
// exercised end-to-end (not just the empty-lead shape).
const LEAD_RUN_ID = uuid()
const LEAD_AGENT_RUN_ID = uuid()
const DELEGATE_TOOL_USE_ID = `tuse-${uuid()}`

let app: FastifyInstance

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  // Stand up the durable org roster (chief + five leads) the route reads.
  seedProfiles()
  const now = Date.now()
  // A cross-run assignment (null owner) so it surfaces in the Objectives panel.
  mgmtDb.insertAssignment.run({
    id: ASSIGNMENT_ID,
    runId: null,
    lead: 'Backend',
    objective: 'chief-route-test objective',
    note: null,
    workflow: null,
    projects: JSON.stringify([]),
    createdAt: now,
    updatedAt: now,
  })

  // One K→Chief delegation (a chief activation with trigger='delegation') so the route's
  // kDelegations edge-count is exercised > 0. Cascade-cleaned when the 'chief' profile is
  // dropped in afterAll (agent_runs ON DELETE CASCADE). run_id null still counts in COUNT.
  agentRunsDb.insertAgentRun.run({
    id: uuid(),
    profileId: 'chief',
    runId: null,
    trigger: 'delegation',
    goal: 'chief-route kDelegations edge',
    projectId: null,
    workflowId: null,
    status: 'completed',
    createdAt: now,
    completedAt: now,
  })

  // Populate the Backend lead: a supervised run + its agent_run activation + one
  // delegate tool call and its paired tool_result. The delegate call is an
  // `assistant` event carrying tool_kind='delegate' + a tool_use_id; the result is
  // the `user` event sharing that tool_use_id (the pairing contract listDelegateEvents
  // and eventsToWorkflowTree rely on).
  runsDb.insertRun.run({
    id: LEAD_RUN_ID,
    prompt: 'backend lead run',
    cwd: '/tmp/k-chief-route-test',
    worktree: null,
    status: 'running',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    projectId: null,
    createdAt: now,
  })
  agentRunsDb.insertAgentRun.run({
    id: LEAD_AGENT_RUN_ID,
    profileId: 'lead-backend',
    runId: LEAD_RUN_ID,
    trigger: 'delegation',
    goal: 'implement the backend slice',
    projectId: null,
    workflowId: null,
    status: 'running',
    createdAt: now,
    completedAt: null,
  })
  // Every named param the insertEvent statement binds — defaulted to null so each
  // row below only overrides the columns it cares about (better-sqlite3 requires
  // ALL named params be present on the object).
  const baseEvent = {
    raw: null, text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null,
    toolUseId: null, toolKind: null, toolInput: null, toolResult: null,
    toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null,
  }
  // The delegate call (assistant, tool_kind='delegate').
  eventsDb.insertEvent.run({
    ...baseEvent,
    id: uuid(), runId: LEAD_RUN_ID, seq: 1, type: 'assistant', ts: now,
    tool: 'Task', toolUseId: DELEGATE_TOOL_USE_ID, toolKind: 'delegate',
    toolInput: JSON.stringify({ subagent_type: 'implementer', prompt: 'do the work' }),
    subagentType: 'implementer', childLabel: 'Backend implementer',
  })
  // Its paired result (user, same tool_use_id).
  eventsDb.insertEvent.run({
    ...baseEvent,
    id: uuid(), runId: LEAD_RUN_ID, seq: 2, type: 'user', ts: now + 1,
    toolUseId: DELEGATE_TOOL_USE_ID,
    toolResult: JSON.stringify([{ type: 'text', text: 'done' }]),
  })
  // A non-delegate event that must NOT reach the tree payload (proves the filter).
  eventsDb.insertEvent.run({
    ...baseEvent,
    id: uuid(), runId: LEAD_RUN_ID, seq: 3, type: 'assistant', ts: now + 2, text: 'thinking…',
  })
})

// The eight durable ids seedProfiles() stands up — deleted below so this suite
// leaves the SHARED core-test DB exactly as it found it. profiles.test.ts asserts a
// clean seed-once, so a leaked roster here would break it under some file orderings
// (the documented shared-temp-dir discipline: every suite cleans up its own rows).
const SEED_IDS = [
  'k-secretary', 'chief', 'default-orchestrator',
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
]

afterAll(async () => {
  try {
    db.prepare('DELETE FROM mgmt_assignments WHERE id = ?').run(ASSIGNMENT_ID)
    db.prepare('DELETE FROM events WHERE run_id = ?').run(LEAD_RUN_ID)
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(LEAD_AGENT_RUN_ID)
    db.prepare('DELETE FROM runs WHERE id = ?').run(LEAD_RUN_ID)
    // Drop the seeded roster (cascades any remaining agent_runs) so the shared DB is
    // restored — otherwise profiles.test.ts's seed-once assertion can see it.
    for (const id of SEED_IDS) db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id)
  } catch { /* ignore */ }
  await app.close()
})

describe('GET /api/chief/org', () => {
  it('returns the batched ChiefOrgPayload shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chief/org', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ChiefOrgPayload

    // chief profile present (seeded).
    expect(body.chief).not.toBeNull()
    expect(body.chief?.name).toBe('Chief')
    expect(body.chief?.tier).toBe('chief')

    // the five discipline leads, each with the lead sub-shape (no default-orchestrator).
    expect(Array.isArray(body.leads)).toBe(true)
    const leadIds = body.leads.map(l => l.profile.id)
    expect(leadIds).toContain('lead-backend')
    expect(leadIds).not.toContain('default-orchestrator')
    for (const lead of body.leads) {
      expect(lead.profile.tier).toBe('orchestrator')
      // latestRun is Run | null; events + wakes are arrays (bounded).
      expect(lead).toHaveProperty('latestRun')
      expect(Array.isArray(lead.events)).toBe(true)
      expect(Array.isArray(lead.wakes)).toBe(true)
    }

    // chiefWakes + assignments arrays; the seeded assignment surfaces.
    expect(Array.isArray(body.chiefWakes)).toBe(true)
    expect(body.assignments.some(a => a.id === ASSIGNMENT_ID)).toBe(true)

    // THIN health only — a leads-active count.
    expect(typeof body.health.leadsActive).toBe('number')
    expect(body.health.leadsActive).toBeGreaterThanOrEqual(0)

    // The K-tier edge count for the whole-org tree — chief activations with
    // trigger='delegation'. One was seeded above, so it is at least 1.
    expect(typeof body.kDelegations).toBe('number')
    expect(body.kDelegations).toBeGreaterThanOrEqual(1)
  })

  it('populates a lead with its latest run + delegate events (delegate-only, no truncation)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chief/org', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ChiefOrgPayload

    const backend = body.leads.find(l => l.profile.id === 'lead-backend')
    expect(backend).toBeDefined()
    // The seeded activation reached a run → latestRun is populated.
    expect(backend?.latestRun?.id).toBe(LEAD_RUN_ID)
    expect(backend?.latestRun?.status).toBe('running')
    // The wake history includes the activation.
    expect(backend?.wakes.some(w => w.id === LEAD_AGENT_RUN_ID)).toBe(true)

    // Only the delegate pair reaches the payload — the plain assistant event (seq 3)
    // is filtered out server-side (listDelegateEvents), and the delegate call carries
    // the fields eventsToWorkflowTree needs to build a sub-agent node.
    const evs = backend?.events ?? []
    const call = evs.find(e => e.toolUseId === DELEGATE_TOOL_USE_ID && e.type === 'assistant')
    const result = evs.find(e => e.toolUseId === DELEGATE_TOOL_USE_ID && e.type === 'user')
    expect(call?.toolKind).toBe('delegate')
    expect(call?.subagentType).toBe('implementer')
    expect(result).toBeDefined()
    // The non-delegate assistant event must NOT be present.
    expect(evs.some(e => e.text === 'thinking…')).toBe(false)
    // Backend's latest run is live → it counts toward the thin health line.
    expect(body.health.leadsActive).toBeGreaterThanOrEqual(1)
  })
})

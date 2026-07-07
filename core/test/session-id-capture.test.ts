/**
 * Lane B (P0) — cli_session_id capture seams (E-22 groundwork).
 *
 * Pure seam: extractInitSessionId parses ONLY a system/init line's session_id.
 * Wire seam: runsDb.setRunCliSessionId (W0) + the routes dbRowToRun mapping
 * surface cliSessionId on GET /api/runs/:id. (The live end-to-end capture —
 * a real CLI init line — is proven by the P0 phase smoke, not here.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import { extractInitSessionId } from '../src/providers.js'
import { runsDb, db } from '../src/db.js'

// Mock the supervisor so importing index.ts can never spawn a real process
// (mirrors app-routes.test.ts).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const INIT_LINE = JSON.stringify({
  type: 'system', subtype: 'init', cwd: 'C:/tmp', session_id: 'abc-123',
  tools: [], model: 'claude-haiku-4-5-20251001',
})

describe('extractInitSessionId', () => {
  it('extracts from a real init line', () => {
    expect(extractInitSessionId(INIT_LINE)).toBe('abc-123')
  })
  it('null for an assistant line', () => {
    expect(extractInitSessionId(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
  })
  it('null for a non-init system line (hook noise)', () => {
    expect(extractInitSessionId(JSON.stringify({ type: 'system', subtype: 'hook', session_id: 'x' }))).toBeNull()
  })
  it('null for missing/empty session_id', () => {
    expect(extractInitSessionId(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(extractInitSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: '' }))).toBeNull()
  })
  it('null for malformed JSON', () => {
    expect(extractInitSessionId('not json')).toBeNull()
  })
})

describe('cli_session_id persistence + wire mapping', () => {
  let app: FastifyInstance
  const runId = uuid()

  beforeAll(async () => {
    process.env.K_SKIP_BOOTSTRAP = '1' // must be set BEFORE importing index.ts
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()
    runsDb.insertRun.run({
      id: runId, prompt: 'p', cwd: 'C:/tmp', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-haiku-4-5-20251001', tokensIn: 0, tokensOut: 0,
      costUsd: 0, projectId: null, createdAt: Date.now(),
    })
  })

  afterAll(async () => {
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId)
    await app.close()
  })

  it('setRunCliSessionId persists and GET /api/runs/:id exposes cliSessionId', async () => {
    runsDb.setRunCliSessionId.run('sess-42', runId)
    expect((runsDb.getRun.get(runId) as { cli_session_id?: string }).cli_session_id).toBe('sess-42')
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().cliSessionId).toBe('sess-42')
  })

  it('a run with no captured session omits/nulls cliSessionId', async () => {
    const bare = uuid()
    runsDb.insertRun.run({
      id: bare, prompt: 'p', cwd: 'C:/tmp', worktree: null, status: 'done',
      provider: 'claude', model: 'claude-haiku-4-5-20251001', tokensIn: 0, tokensOut: 0,
      costUsd: 0, projectId: null, createdAt: Date.now(),
    })
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${bare}`, headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.json().cliSessionId ?? undefined).toBeUndefined()
    } finally {
      db.prepare('DELETE FROM runs WHERE id = ?').run(bare)
    }
  })
})

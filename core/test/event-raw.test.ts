import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { runsDb, eventsDb, db } from '../src/db.js'

const RUN_ID = uuid()
const SEQ_WITH_RAW = 1
const SEQ_WITHOUT_RAW = 2

// Seed: one run + two events (one with raw, one without)
runsDb.insertRun.run({
  id: RUN_ID,
  prompt: 'event-raw test',
  cwd: '/tmp',
  worktree: null,
  status: 'done',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  projectId: null,
  createdAt: Date.now(),
})

eventsDb.insertEvent.run({
  id: uuid(),
  runId: RUN_ID,
  seq: SEQ_WITH_RAW,
  type: 'assistant',
  ts: Date.now(),
  raw: '{"type":"assistant","text":"hello"}',
  text: 'hello',
  tool: null,
  tokensIn: null,
  tokensOut: null,
  costUsd: null,
  toolUseId: null,
  toolKind: null,
  toolInput: null,
  toolResult: null,
  toolResultIsError: null,
  subagentType: null,
  childLabel: null,
})

eventsDb.insertEvent.run({
  id: uuid(),
  runId: RUN_ID,
  seq: SEQ_WITHOUT_RAW,
  type: 'usage',
  ts: Date.now(),
  raw: null,
  text: null,
  tool: null,
  tokensIn: 10,
  tokensOut: 20,
  costUsd: 0.001,
  toolUseId: null,
  toolKind: null,
  toolInput: null,
  toolResult: null,
  toolResultIsError: null,
  subagentType: null,
  childLabel: null,
})

afterAll(() => {
  db.prepare('DELETE FROM events WHERE run_id = ?').run(RUN_ID)
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN_ID)
})

describe('eventsDb.getEventRaw', () => {
  it('returns the raw string for an event that has one', () => {
    const row = eventsDb.getEventRaw.get(RUN_ID, SEQ_WITH_RAW) as { raw: string | null } | undefined
    expect(row).toBeDefined()
    expect(row!.raw).toBe('{"type":"assistant","text":"hello"}')
  })

  it('returns null raw for an event stored without raw', () => {
    const row = eventsDb.getEventRaw.get(RUN_ID, SEQ_WITHOUT_RAW) as { raw: string | null } | undefined
    expect(row).toBeDefined()
    // Row exists but raw column is null — route will 404 on this case
    expect(row!.raw).toBeNull()
  })

  it('returns undefined for a non-existent seq', () => {
    const row = eventsDb.getEventRaw.get(RUN_ID, 999)
    expect(row).toBeUndefined()
  })

  it('returns undefined for a non-existent run_id', () => {
    const row = eventsDb.getEventRaw.get('no-such-run', SEQ_WITH_RAW)
    expect(row).toBeUndefined()
  })
})

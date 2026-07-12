import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { db, memoriesDb } from '../src/db.js'
import { logisticsTools } from '../src/mcp/logistics.js'

const tool = () => logisticsTools.find(t => t.name === 'memory_save')!

beforeEach(() => {
  db.prepare(`DELETE FROM user_memories`).run()
  db.prepare(`DELETE FROM notifications WHERE event_key = 'memory_saved'`).run()
  db.prepare(`DELETE FROM k_thread_turns`).run()
  db.prepare(`DELETE FROM k_threads WHERE id LIKE 'kt-test%'`).run()
  delete process.env.K_RUN_ID
})
afterAll(() => { delete process.env.K_RUN_ID })

it('is registered as a logistics tool, and the secretary can actually reach + is told about it', () => {
  expect(tool()).toBeDefined()
  const allow = JSON.parse(fs.readFileSync(path.join(process.cwd(), '..', 'agent-config', 'allowlists', 'secretary.json'), 'utf8')).allowedTools as string[]
  expect(allow.includes('mcp__logistics') || allow.some(t => t.startsWith('mcp__logistics__'))).toBe(true)
  const charter = fs.readFileSync(path.join(process.cwd(), '..', 'agent-config', 'tiers', 'secretary.charter.md'), 'utf8')
  expect(charter).toContain('memory_save')
})

it('saves a memory, stamps sourceThreadId from the active run, and inserts a quiet notification', () => {
  db.prepare(`INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES ('mem-run-1', 'x', '.', 'running', ?)`).run(Date.now())
  db.prepare(`INSERT INTO k_threads (id, title, status, active_run_id, created_at, updated_at) VALUES ('kt-test1', 't', 'active', 'mem-run-1', ?, ?)`).run(Date.now(), Date.now())
  process.env.K_RUN_ID = 'mem-run-1'
  const result = tool().handler({ content: 'operator prefers tabs collapsed' }) as { id: string; sourceThreadId: string | null }
  expect(result.sourceThreadId).toBe('kt-test1')
  expect(memoriesDb.getMemory.get(result.id)).toBeDefined()
  const notif = db.prepare(`SELECT * FROM notifications WHERE event_key = 'memory_saved'`).all()
  expect(notif.length).toBe(1)
})

it('respects the notification rule (inapp=0 suppresses the row) and rejects empty content', () => {
  db.prepare(`UPDATE notification_rules SET inapp = 0 WHERE event_key = 'memory_saved'`).run()
  const result = tool().handler({ content: 'quiet save' }) as { id: string }
  expect(memoriesDb.getMemory.get(result.id)).toBeDefined()
  expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE event_key='memory_saved'`).get()).toEqual({ n: 0 })
  db.prepare(`UPDATE notification_rules SET inapp = 1 WHERE event_key = 'memory_saved'`).run()
  expect(() => tool().handler({ content: '' })).toThrow()
})

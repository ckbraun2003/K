/**
 * sub-agents.ts — the sub-agent worker registry (Orchestration Program Phase 2, W0
 * Task 0.4). Two sources merge under one SubAgentDef shape:
 *   - K-native: parsed at read time from agent-config/agents/*.md (Claude-Code-
 *     subagent-shaped frontmatter + body). source:'k', read-only.
 *   - Operator: rows in sub_agent_defs (full CRUD via subAgentDb).
 *
 * Isolated DB: shares the suite's on-disk SQLite file (vitest.config.ts K_DATA_DIR,
 * mirroring workflow-defs.test.ts) — every operator row this suite creates is
 * cleaned up in afterAll so nothing leaks into other test files.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import {
  listSubAgents,
  getSubAgentByName,
  createSubAgent,
  updateSubAgent,
  deleteSubAgent,
} from '../src/sub-agents.js'

const K_NATIVE_NAMES = [
  'implementer',
  'spec-reviewer',
  'security-reviewer',
  'quality-reviewer',
  'debugger',
  'planner',
]

const createdIds: string[] = []
afterAll(() => {
  for (const id of createdIds) db.prepare('DELETE FROM sub_agent_defs WHERE id = ?').run(id)
})

describe('listSubAgents — K-native workers', () => {
  it('returns all 6 K-native workers, source:k, parsed from disk', () => {
    const all = listSubAgents()
    const kNative = all.filter(a => a.source === 'k')
    const names = kNative.map(a => a.name)
    for (const n of K_NATIVE_NAMES) expect(names).toContain(n)
    for (const a of kNative) {
      expect(a.source).toBe('k')
      expect(a.enabled).toBe(true)
      expect(a.id.startsWith('k:')).toBe(true)
    }
  })
})

describe('getSubAgentByName — K-native resolution', () => {
  it('resolves "implementer" with a non-empty prompt and its role', () => {
    const worker = getSubAgentByName('implementer')
    expect(worker).toBeDefined()
    expect(worker!.source).toBe('k')
    expect(worker!.prompt.length).toBeGreaterThan(0)
    expect(worker!.prompt).toContain('implementer')
    expect(worker!.role).toContain('Implements ONE task')
  })

  it('returns undefined for an unknown name', () => {
    expect(getSubAgentByName('no-such-worker-xyz')).toBeUndefined()
  })
})

describe('operator sub-agent CRUD', () => {
  it('createSubAgent appears in listSubAgents with source:operator; updateSubAgent mutates it; deleteSubAgent removes it', () => {
    const name = `test-operator-${uuid().slice(0, 8)}`
    const created = createSubAgent({
      name,
      role: 'A test operator worker',
      model: 'sonnet',
      allowedTools: ['Read'],
      mcpServers: [],
      skills: [],
      prompt: 'You are a test worker.',
    })
    createdIds.push(created.id)

    expect(created.source).toBe('operator')
    expect(created.name).toBe(name)
    expect(listSubAgents().some(a => a.id === created.id && a.source === 'operator')).toBe(true)

    const updated = updateSubAgent(created.id, { role: 'An updated role', enabled: false })
    expect(updated.role).toBe('An updated role')
    expect(updated.enabled).toBe(false)
    expect(updated.name).toBe(name) // untouched field preserved (read-merge-write)

    deleteSubAgent(created.id)
    expect(listSubAgents().some(a => a.id === created.id)).toBe(false)
    expect(getSubAgentByName(name)).toBeUndefined()
  })
})

describe('K-native workers are read-only', () => {
  it('updateSubAgent on a K-native id throws', () => {
    const kWorker = getSubAgentByName('implementer')!
    expect(() => updateSubAgent(kWorker.id, { role: 'hacked' })).toThrow()
  })

  it('deleteSubAgent on a K-native id throws', () => {
    const kWorker = getSubAgentByName('planner')!
    expect(() => deleteSubAgent(kWorker.id)).toThrow()
  })

  it('createSubAgent with a K-native name throws/rejects', () => {
    expect(() =>
      createSubAgent({
        name: 'implementer',
        role: 'collision attempt',
        prompt: 'x',
      }),
    ).toThrow()
  })
})

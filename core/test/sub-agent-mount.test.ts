/**
 * orch-p2 Lane A / Task A.5 — sub-agent resolution + confined run-mount (TOKEN-FREE).
 *
 * A pipeline `agent` stage's `subagentType` resolves to a worker-bee def (getSubAgentByName, W0)
 * and is MOUNTED into the run's synthesized config dir:
 *   - K-native workers ship in agent-config/agents/<name>.md (bundle-style copy);
 *   - operator workers are copied CONFINED from dataDir/agents/<id>/ (the hook data/hooks/ idiom),
 *     fail-CLOSED: a disabled worker is skipped, and a path-escape id is rejected.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesizeConfigDir, type SynthesizeOpts } from '../src/agent-config.js'
import { getSubAgentByName } from '../src/sub-agents.js'
import { DEFAULT_PROFILE } from '../src/profiles.js'
import type { SubAgentDef } from '@k/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const tmpDirs: string[] = []

function freshDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-samount-'))
  tmpDirs.push(d)
  return d
}
function synth(dataDir: string, extra: Partial<SynthesizeOpts> = {}) {
  const runId = 'run-' + Math.random().toString(36).slice(2)
  return synthesizeConfigDir(DEFAULT_PROFILE, { runId, dataDir, assetsDir: ASSET_DIR, ...extra })
}
/** Materialize an operator worker's confined dir (dataDir/agents/<id>/agent.md). */
function seedOperatorWorkerDir(dataDir: string, id: string): void {
  const dir = path.join(dataDir, 'agents', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.md'), '---\nname: op\n---\nbody\n')
}
function operatorDef(over: Partial<SubAgentDef> = {}): SubAgentDef {
  return {
    id: 'op-0001', name: 'myworker', role: 'a worker', model: null,
    allowedTools: [], mcpServers: [], skills: [], prompt: 'do work',
    source: 'operator', enabled: true, ...over,
  }
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key' })
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
})
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('sub-agent resolution + confined mount (A.5)', () => {
  it('resolves a K-native subagentType and mounts the worker into the config dir', () => {
    const def = getSubAgentByName('implementer') // W0 registry — reads agent-config/agents/implementer.md
    expect(def).toBeDefined()
    expect(def!.source).toBe('k')
    const dataDir = freshDataDir()
    const cfg = synth(dataDir, { subagent: def })
    expect(fs.existsSync(path.join(cfg.configDir, 'agents', 'implementer.md'))).toBe(true)
  })

  it('copies an ENABLED operator worker CONFINED from dataDir/agents/<id>/', () => {
    const dataDir = freshDataDir()
    seedOperatorWorkerDir(dataDir, 'op-0001')
    const cfg = synth(dataDir, { subagent: operatorDef() })
    expect(fs.existsSync(path.join(cfg.configDir, 'agents', 'op-0001', 'agent.md'))).toBe(true)
  })

  it('does NOT mount a DISABLED operator worker (fail-closed)', () => {
    const dataDir = freshDataDir()
    seedOperatorWorkerDir(dataDir, 'op-0001')
    const cfg = synth(dataDir, { subagent: operatorDef({ enabled: false }) })
    expect(fs.existsSync(path.join(cfg.configDir, 'agents', 'op-0001'))).toBe(false)
  })

  it('REJECTS a path-escape operator id (fail-closed)', () => {
    const dataDir = freshDataDir()
    expect(() => synth(dataDir, { subagent: operatorDef({ id: '../escape' }) })).toThrow()
  })
})

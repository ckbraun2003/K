/**
 * Campaign S4 — per-tier allowlist synthesis (LOCK suite).
 *
 * `synthesizeConfigDir` returns `allowedTools` — the EXACT roster passed to
 * `claude --allowedTools` for a managed run. The agent-config-assets test pins
 * the on-disk allowlist JSON (contains/excludes); these tests pin the SYNTHESIZER
 * OUTPUT contract: the precise array each tier yields, that it never drifts from
 * the asset on disk, that the chief/secretary coding-tool boundary holds, and
 * that a non-allowlisted `mcp__*` server is absent (so its tools are denied in
 * headless `-p`).
 *
 * Findings: S4-001 (orchestrator exact set), S4-002 (chief exact set),
 * S4-003 (secretary exact set), S4-004 (no drift + non-allowlisted mcp denied).
 * See testing/findings/S4-prompt-delegation.md.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { DEFAULT_PROFILE, type CharterName } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const tmpDirs: string[] = []

/** Synthesize as a given charter tier into a fresh temp dataDir. */
function synthAs(charterTier: CharterName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-allow-'))
  tmpDirs.push(dataDir)
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const profile = { ...DEFAULT_PROFILE, tier: charterTier, charter: charterTier }
  return synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeEach(() => {
  // Pin a K token so synthesis resolves auth via the token path and never copies
  // a dogfooding machine's real host credentials.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// The exact allowedTools each tier MUST yield (order included — the synthesizer
// returns the asset array verbatim). These are the authority boundary in code.
const EXACT: Record<CharterName, string[]> = {
  orchestrator: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Task', 'WebFetch', 'WebSearch', 'mcp__gitnexus', 'mcp__kstore'],
  chief: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__gitnexus', 'mcp__kstore'],
  secretary: ['Read', 'WebFetch', 'WebSearch', 'mcp__kstore'],
}

describe('S4 allowlist synthesis: exact per-tier roster', () => {
  it('S4-001: orchestrator yields the full coding roster, exactly', () => {
    const cfg = synthAs('orchestrator')
    expect(cfg.allowedTools).toEqual(EXACT.orchestrator)
  })

  it('S4-002: chief yields read+research+mcp only — NO Bash/Write/Edit/Task', () => {
    const cfg = synthAs('chief')
    expect(cfg.allowedTools).toEqual(EXACT.chief)
    for (const denied of ['Bash', 'Write', 'Edit', 'Task', 'Agent']) {
      expect(cfg.allowedTools).not.toContain(denied)
    }
  })

  it('S4-003: secretary yields the leanest set (Read+research+kstore) — NO coding tools, NO Grep/Glob, NO gitnexus', () => {
    const cfg = synthAs('secretary')
    expect(cfg.allowedTools).toEqual(EXACT.secretary)
    for (const denied of ['Bash', 'Write', 'Edit', 'Task', 'Grep', 'Glob', 'mcp__gitnexus']) {
      expect(cfg.allowedTools).not.toContain(denied)
    }
  })
})

describe('S4 allowlist synthesis: no drift + non-allowlisted mcp denied', () => {
  it('S4-004: returned allowedTools is byte-identical to the on-disk asset (no synth drift)', () => {
    for (const tier of ['orchestrator', 'chief', 'secretary'] as CharterName[]) {
      const cfg = synthAs(tier)
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(ASSET_DIR, 'allowlists', `${tier}.json`), 'utf8'),
      ) as { allowedTools: string[] }
      expect(cfg.allowedTools, `${tier} drift`).toEqual(onDisk.allowedTools)
    }
  })

  it('S4-004: no tier grants a non-allowlisted mcp server (a planted mcp__foo is never present)', () => {
    for (const tier of ['orchestrator', 'chief', 'secretary'] as CharterName[]) {
      const cfg = synthAs(tier)
      // Only the two real K servers are ever granted; any other mcp__* is denied.
      const mcpGrants = cfg.allowedTools.filter(t => t.startsWith('mcp__')).sort()
      const allowed = tier === 'secretary' ? ['mcp__kstore'] : ['mcp__gitnexus', 'mcp__kstore']
      expect(mcpGrants, `${tier} mcp grants`).toEqual(allowed)
      expect(cfg.allowedTools, `${tier} must not grant mcp__foo`).not.toContain('mcp__foo')
    }
  })
})

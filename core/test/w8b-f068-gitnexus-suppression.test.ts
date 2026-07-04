/**
 * W8b F-068 — gitnexus suppression for an EXTERNAL-target dispatched run (LOCK).
 *
 * A lead run dispatched into a registered EXTERNAL project must NOT bootstrap gitnexus:
 * the gitnexus MCP server's init AND the `gitnexus analyze` nudge (the PostToolUse hook)
 * resolve the canonical repo root via the SHARED git dir, so they write `.gitnexus/`, a
 * `.gitignore` line, and `.claude/skills/gitnexus` into the TARGET checkout (residue
 * removeWorktree never cleans). synthesizeConfigDir(..., { suppressGitnexus:true }) must
 * therefore mount NO gitnexus MCP server and strip the gitnexus hook groups from
 * settings.json. A K-INTERNAL run (suppressGitnexus:false/omitted) keeps both — proven
 * byte-for-byte against the existing S4 synthesis LOCK.
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

function freshDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-f068-'))
  tmpDirs.push(d)
  return d
}

function synth(charter: CharterName, opts: { suppressGitnexus?: boolean } = {}) {
  const profile = { ...DEFAULT_PROFILE, tier: charter, charter, allowedTools: [], mcpServers: [], skills: [] }
  return synthesizeConfigDir(profile, {
    runId: 'run-' + Math.random().toString(36).slice(2),
    dataDir: freshDataDir(),
    assetsDir: ASSET_DIR,
    suppressGitnexus: opts.suppressGitnexus,
  })
}

function readMcp(cfg: { mcpConfigPath: string }) {
  return JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
    mcpServers: Record<string, unknown>
  }
}
function readSettings(cfg: { settingsPath: string }) {
  return JSON.parse(fs.readFileSync(cfg.settingsPath, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
}
/** Every hook command across every event in a settings.json. */
function allHookCommands(cfg: { settingsPath: string }): string[] {
  const hooks = readSettings(cfg).hooks ?? {}
  const cmds: string[] = []
  for (const groups of Object.values(hooks)) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (h.command) cmds.push(h.command)
  }
  return cmds
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

describe('F-068: external-target run suppresses the gitnexus MCP server', () => {
  it('an EXTERNAL-target orchestrator run mounts NO gitnexus server (kstore stays)', () => {
    const cfg = synth('orchestrator', { suppressGitnexus: true })
    const servers = Object.keys(readMcp(cfg).mcpServers).sort()
    expect(servers).not.toContain('gitnexus')
    expect(servers).toContain('kstore') // the K-owned store is untouched — only gitnexus is dropped
  })

  it('a K-INTERNAL orchestrator run STILL mounts gitnexus (default behavior)', () => {
    const cfg = synth('orchestrator') // suppressGitnexus omitted → K-internal
    const servers = Object.keys(readMcp(cfg).mcpServers).sort()
    expect(servers).toEqual(['gitnexus', 'kstore'])
  })

  it('chief external-target drops gitnexus but keeps kstore + mgmt', () => {
    const cfg = synth('chief', { suppressGitnexus: true })
    const servers = Object.keys(readMcp(cfg).mcpServers).sort()
    expect(servers).toEqual(['kstore', 'mgmt'])
  })
})

describe('F-068: external-target run strips the gitnexus analyze hook', () => {
  it('an EXTERNAL-target run has NO gitnexus hook wired in settings.json', () => {
    const cfg = synth('orchestrator', { suppressGitnexus: true })
    expect(allHookCommands(cfg).some(c => c.includes('gitnexus-hook'))).toBe(false)
    // Every hook in the shipped template is a gitnexus hook, so hooks are fully stripped.
    expect(allHookCommands(cfg)).toHaveLength(0)
  })

  it('a K-INTERNAL run KEEPS the gitnexus Pre/PostToolUse hooks (unchanged)', () => {
    const cfg = synth('orchestrator')
    const cmds = allHookCommands(cfg)
    expect(cmds.length).toBeGreaterThan(0)
    expect(cmds.every(c => c.includes('gitnexus-hook.cjs'))).toBe(true)
    const settings = readSettings(cfg)
    expect(settings.hooks?.PreToolUse).toBeDefined()
    expect(settings.hooks?.PostToolUse).toBeDefined()
  })
})

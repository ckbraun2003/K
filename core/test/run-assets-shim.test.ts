/**
 * run-assets.ts — the model-neutral seam SHIM vs synthesizeConfigDir (Wave 0).
 *
 * The PARITY LOCK: for the same profile + runId + dataDir, resolveRunAssets must
 * report exactly what synthesizeConfigDir materializes — same system-prompt
 * content, same skill mounts, same MCP server set including the run-scoped
 * kstore/logistics/mgmt rewriting (process.execPath + tsx loader + rewritten
 * K_DATA_DIR/K_RUN_ID env), same allowedTools/disallowedTools — while performing
 * ZERO filesystem writes. Lane B builds against the shim; Lane A (A3) swaps the
 * synthesizer onto it; this suite is what keeps the two from drifting meanwhile.
 *
 * Mirrors agent-config-profile.test.ts fixture idioms: hand-built profiles, temp
 * dataDirs, ANTHROPIC_API_KEY pinned so synthesis never copies host credentials.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { resolveRunAssets } from '../src/run-assets.js'
import { GrantError } from '../src/authority.js'
import type { AgentProfile } from '../src/profiles.js'
import { db, memoriesDb } from '../src/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const tmpDirs: string[] = []

function profileWith(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'w0-shim-test',
    name: 'w0-shim-test',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...overrides,
  }
}

/** Synthesize + resolve the SAME inputs side by side. */
function both(profile: AgentProfile, opts: { suppressGitnexus?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-run-assets-'))
  tmpDirs.push(dataDir)
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const cfg = synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR, ...opts })
  const assets = resolveRunAssets(profile, { runId, dataDir, assetsDir: ASSET_DIR, ...opts })
  return { cfg, assets, dataDir, runId }
}

const skillDirNames = (configDir: string): string[] => {
  const root = path.join(configDir, 'skills')
  return fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : []
}

type McpJson = {
  mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})

afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('resolveRunAssets — shim ≡ synthesizeConfigDir (orchestrator tier, no override)', () => {
  it('same allowedTools / disallowedTools', () => {
    const { cfg, assets } = both(profileWith())
    expect(assets.allowedTools).toEqual(cfg.allowedTools)
    expect(assets.disallowedTools).toEqual(cfg.disallowedTools)
  })

  it('same system-prompt CONTENT (L0 + L1, same joiner)', () => {
    const { cfg, assets } = both(profileWith())
    expect(assets.systemPrompt).toBe(fs.readFileSync(cfg.appendSystemPromptFile, 'utf8'))
  })

  it('same skills list as the mounted skill dirs; k-native identity fields', () => {
    const { cfg, assets } = both(profileWith())
    expect(assets.skills.map(s => s.mountDirName).sort()).toEqual(skillDirNames(cfg.configDir))
    for (const s of assets.skills) {
      expect(s.sourceKind).toBe('k')
      expect(s.qualifiedKey).toBe(s.name) // k-native: bare name IS the qualified key
      expect(s.mountDirName).toBe(s.name)
      expect(fs.existsSync(s.srcDir)).toBe(true)
      // srcDir points INTO the assets library (read in place — nothing vendored by the shim).
      expect(s.srcDir).toBe(path.join(ASSET_DIR, 'skills', s.name))
    }
  })

  it('same MCP server set incl. the run-scoped kstore rewriting (execPath, loader args, K_DATA_DIR/K_RUN_ID env)', () => {
    const { cfg, assets, dataDir, runId } = both(profileWith())
    const written = (JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as McpJson).mcpServers
    // Same server names, same order (template key order).
    expect(assets.mcpServers.map(s => s.name)).toEqual(Object.keys(written))
    for (const srv of assets.mcpServers) {
      const w = written[srv.name]
      expect(srv.config.command).toBe(w.command ?? '')
      expect(srv.config.args).toEqual(w.args ?? [])
      expect(srv.config.env).toEqual(w.env ?? {})
      expect(srv.sourceKind).toBe('k')
      expect(srv.estTokens).toBeNull() // never probed in the shim (D-070)
    }
    // The kstore rewrite specifically: THIS node, THIS run's data dir + id.
    const kstore = assets.mcpServers.find(s => s.name === 'kstore')!
    expect(kstore.config.command).toBe(process.execPath)
    expect(kstore.config.env.K_DATA_DIR).toBe(dataDir)
    expect(kstore.config.env.K_RUN_ID).toBe(runId)
    // gitnexus passes through UNTOUCHED (no rewrite, no env injection).
    const gitnexus = assets.mcpServers.find(s => s.name === 'gitnexus')!
    expect(gitnexus.config.command).toBe('npx')
    expect(gitnexus.config.env).toEqual({})
  })

  it('estTokens: bodies sum the per-skill estimates; meta > 0; mcpTools null', () => {
    const { assets } = both(profileWith())
    expect(assets.estTokens.skillsBodies).toBe(assets.skills.reduce((n, s) => n + s.estTokens, 0))
    expect(assets.skills.every(s => s.estTokens > 0)).toBe(true) // every shipped skill has a SKILL.md
    expect(assets.estTokens.skillsMeta).toBeGreaterThan(0)
    expect(assets.estTokens.skillsMeta).toBeLessThan(assets.estTokens.skillsBodies) // meta ⊂ body
    expect(assets.estTokens.mcpTools).toBeNull()
  })

  it('performs NO filesystem writes (the whole point of the seam)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-run-assets-'))
    tmpDirs.push(dataDir)
    resolveRunAssets(profileWith(), { runId: 'run-nowrite', dataDir, assetsDir: ASSET_DIR })
    expect(fs.readdirSync(dataDir)).toEqual([]) // no agent-runs/, no config dir, nothing
  })
})

describe('resolveRunAssets — shim ≡ synthesizeConfigDir (narrowed profile row)', () => {
  const narrowed = () =>
    profileWith({
      allowedTools: ['Read', 'Grep', 'mcp__kstore'],
      mcpServers: ['kstore'],
      skills: ['search-first'],
    })

  it('honors the narrowed grant identically', () => {
    const { cfg, assets } = both(narrowed())
    expect(assets.allowedTools).toEqual(['Read', 'Grep', 'mcp__kstore'])
    expect(assets.disallowedTools).toEqual(cfg.disallowedTools)
    expect(assets.skills.map(s => s.name)).toEqual(['search-first'])
    expect(assets.mcpServers.map(s => s.name)).toEqual(['kstore'])
    const written = (JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as McpJson).mcpServers
    expect(Object.keys(written)).toEqual(['kstore'])
  })
})

describe('resolveRunAssets — F-068 suppressGitnexus drop', () => {
  it('drops gitnexus from the mounted set, in lockstep with the synthesizer', () => {
    const { cfg, assets } = both(profileWith(), { suppressGitnexus: true })
    expect(assets.mcpServers.map(s => s.name)).not.toContain('gitnexus')
    const written = (JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as McpJson).mcpServers
    expect(assets.mcpServers.map(s => s.name)).toEqual(Object.keys(written))
  })
})

describe('resolveRunAssets — fail-closed narrowing (typed GrantError)', () => {
  const resolve = (profile: AgentProfile) => () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-run-assets-'))
    tmpDirs.push(dataDir)
    resolveRunAssets(profile, { runId: 'run-err', dataDir, assetsDir: ASSET_DIR })
  }

  it('GrantError on an out-of-ceiling tool (secretary tier granted Bash)', () => {
    const p = profileWith({ tier: 'secretary', charter: 'secretary', allowedTools: ['Bash'] })
    expect(resolve(p)).toThrow(GrantError)
    expect(resolve(p)).toThrow(/exceeds the .* tier ceiling/)
  })

  it('GrantError on the dead Agent token (orchestrator ceiling)', () => {
    expect(resolve(profileWith({ allowedTools: ['Bash', 'Agent'] }))).toThrow(GrantError)
  })

  it('GrantError on an MCP server the tier template does not define', () => {
    const p = profileWith({ mcpServers: ['kstore', 'ghost'], allowedTools: ['mcp__ghost', 'mcp__kstore'] })
    expect(resolve(p)).toThrow(GrantError)
    expect(resolve(p)).toThrow(/defines no such server/)
  })

  it('GrantError on a skill outside the tier bundle', () => {
    const p = profileWith({ skills: ['definitely-not-a-skill'] })
    expect(resolve(p)).toThrow(GrantError)
    expect(resolve(p)).toThrow(/tier bundle is the ceiling/)
  })

  it('GrantError on mounting ≠ granting (D-034 holds at the seam)', () => {
    const p = profileWith({ mcpServers: ['kstore'], allowedTools: ['Read'] })
    expect(resolve(p)).toThrow(GrantError)
    expect(resolve(p)).toThrow(/does not grant it/)
  })
})

describe('resolveRunAssets — secretary operator-memories system-prompt block (Task 4)', () => {
  afterAll(() => {
    db.prepare(`DELETE FROM user_memories WHERE id = 'um-t1'`).run()
  })

  it('secretary system prompt carries the operator-memories block when memories exist', () => {
    memoriesDb.insertMemory.run({
      id: 'um-t1',
      content: 'prefers concise answers',
      sourceThreadId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-run-assets-'))
    tmpDirs.push(dataDir)
    const assets = resolveRunAssets(profileWith({ tier: 'secretary', charter: 'secretary' }), {
      runId: 'run-mem-secretary',
      dataDir,
      assetsDir: ASSET_DIR,
    })
    expect(assets.systemPrompt).toContain('What you remember about your operator')
    expect(assets.systemPrompt).toContain('prefers concise answers')
  })

  it('orchestrator system prompt never carries the memories block', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-run-assets-'))
    tmpDirs.push(dataDir)
    const assets = resolveRunAssets(profileWith(), {
      runId: 'run-mem-orchestrator',
      dataDir,
      assetsDir: ASSET_DIR,
    })
    expect(assets.systemPrompt).not.toContain('What you remember about your operator')
  })
})

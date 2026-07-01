/**
 * Wave 2 — per-run config synthesizer (core/src/agent-config.ts).
 *
 * synthesizeConfigDir materializes an ephemeral, K-OWNED config dir that the
 * Claude Code CLI is spawned into via CLAUDE_CONFIG_DIR, so the host ~/.claude
 * (skills/plugins/MCP/settings/credentials) is NEVER loaded. These tests guard:
 *   - the layered system prompt (L0 base + L1 charter) is written and complete,
 *   - settings.json has its __HOOK__ placeholder rewritten to the run's hooks dir,
 *   - skills/hooks/mcp/allowlist assets are materialized for the tier,
 *   - the WRITTEN config files leak no host path (isolation),
 *   - auth resolves K token first, host-credential dogfooding fallback second,
 *   - cleanup() removes the run dir.
 *
 * Each test synthesizes into its own temp dataDir (fs.mkdtemp under os.tmpdir())
 * with the REAL repo agent-config/ as assetsDir. ANTHROPIC_API_KEY is pinned to
 * 'test-key' in beforeEach so the structural tests never trip the host-credential
 * fallback (and never copy a dogfooding machine's real credentials); the env is
 * snapshotted and restored after every test.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { synthesizeConfigDir, pruneOrphanAgentRuns } from '../src/agent-config.js'
import type { SynthesizeOpts } from '../src/agent-config.js'
import { DEFAULT_PROFILE, type CharterName } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const tmpDirs: string[] = []

/** Synthesize into a fresh temp dataDir. Returns the SynthesizedConfig. */
function synth(extra: Partial<SynthesizeOpts> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-'))
  tmpDirs.push(dataDir)
  const runId = 'run-' + Math.random().toString(36).slice(2)
  return synthesizeConfigDir(DEFAULT_PROFILE, { runId, dataDir, assetsDir: ASSET_DIR, ...extra })
}

/** Recursively collect every file path under `dir` (empty if dir is absent). */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeEach(() => {
  // Pin a K token so structural tests resolve auth via the token path and never
  // copy a dogfooding machine's real host credentials. Auth tests override this.
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

describe('synthesizeConfigDir', () => {
  it('writes a layered system prompt with BOTH the L0 base and the L1 orchestrator charter', () => {
    const cfg = synth()
    expect(fs.existsSync(cfg.configDir)).toBe(true)
    expect(cfg.appendSystemPromptFile).toBe(path.join(cfg.configDir, 'system-prompt.md'))
    const prompt = fs.readFileSync(cfg.appendSystemPromptFile, 'utf8')
    // L0 marker (base operating prompt) …
    expect(prompt).toMatch(/Harness|Must \/ Must Not/)
    // … AND the orchestrator charter marker (L1).
    expect(prompt).toContain('harness delegation loop')
  })

  it('rewrites the __HOOK__ placeholder in settings.json to the run hooks dir', () => {
    const cfg = synth()
    expect(fs.existsSync(cfg.settingsPath)).toBe(true)
    const raw = fs.readFileSync(cfg.settingsPath, 'utf8')
    expect(raw).not.toContain('__HOOK__')
    const settings = JSON.parse(raw)
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command as string
    const hooksFwd = path.join(cfg.configDir, 'hooks').split(path.sep).join('/')
    expect(cmd).toContain(hooksFwd)
  })

  it('materializes skills/, hooks/gitnexus-hook.cjs, and an mcp.json with mcpServers.gitnexus', () => {
    const cfg = synth()
    const skillFiles = walk(path.join(cfg.configDir, 'skills')).filter(p => p.endsWith('SKILL.md'))
    expect(skillFiles.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(cfg.configDir, 'hooks', 'gitnexus-hook.cjs'))).toBe(true)
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8'))
    expect(mcp.mcpServers?.gitnexus).toBeDefined()
  })

  it('exposes the orchestrator allowlist including Bash and Task', () => {
    const cfg = synth()
    expect(cfg.allowedTools).toContain('Bash')
    expect(cfg.allowedTools).toContain('Task')
  })

  it('leaks no host config path in the synthesizer-written files', () => {
    const cfg = synth()
    const homeClaude = path.join(os.homedir(), '.claude')
    // Paths that LEGITIMATELY appear in K's own config: the run's configDir (the
    // settings hook path), its parent dataDir + the kstore K_DATA_DIR, the kstore
    // server module, and the node binary that launches it (mcp.json command/args).
    // These are K-owned, not the host ~/.claude — strip them so the scan catches
    // only foreign/host leakage. (On Windows os.tmpdir() nests under os.homedir(),
    // so the run/data paths would otherwise contain C:\Users / AppData.)
    const dataDir = path.resolve(cfg.configDir, '..', '..', '..')
    const mcpDir = path.join(__dirname, '..', 'src', 'mcp')
    // the dev args carry the absolute tsx loader URL (under K's own node_modules)
    const tsxHref = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const legit = [
      cfg.configDir,
      dataDir,
      path.join(mcpDir, 'k-store-server.ts'),
      path.join(mcpDir, 'k-store-server.js'),
      process.execPath,
      tsxHref,
    ]
    // Strip the native, forward-slash, AND JSON-escaped (C:\\Users\\…) forms of
    // each legit path — mcp.json stores absolute paths JSON-escaped.
    const variants = (p: string): string[] => [p, p.split(path.sep).join('/'), JSON.stringify(p).slice(1, -1)]
    const strip = (s: string): string => {
      for (const p of legit) for (const v of variants(p)) s = s.split(v).join('<K>')
      return s
    }
    for (const name of ['system-prompt.md', 'settings.json', 'mcp.json']) {
      const body = strip(fs.readFileSync(path.join(cfg.configDir, name), 'utf8'))
      expect(body, name).not.toContain('AppData')
      expect(body, name).not.toContain('C:\\Users')
      expect(body, name).not.toContain('C:/Users')
      expect(body, name).not.toContain(os.homedir())
      expect(body, name).not.toContain(homeClaude)
      expect(body.toLowerCase(), name).not.toContain('.credentials.json')
    }
  })

  it('auth — uses ANTHROPIC_API_KEY (no host-credential fallback, no .credentials.json)', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const cfg = synth()
    expect(cfg.authEnv.ANTHROPIC_API_KEY).toBe('test-key')
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(fs.existsSync(path.join(cfg.configDir, '.credentials.json'))).toBe(false)
  })

  it('auth — falls back to copying host credentials when no K token is set', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-cred-'))
    tmpDirs.push(fixtureDir)
    const hostCredentialsPath = path.join(fixtureDir, '.credentials.json')
    fs.writeFileSync(hostCredentialsPath, JSON.stringify({ token: 'host-secret' }), 'utf8')

    const cfg = synth({ hostCredentialsPath })

    expect(cfg.usedHostCredentialFallback).toBe(true)
    expect(cfg.authEnv).toEqual({})
    const copied = path.join(cfg.configDir, '.credentials.json')
    expect(fs.existsSync(copied)).toBe(true)
    expect(JSON.parse(fs.readFileSync(copied, 'utf8'))).toEqual({ token: 'host-secret' })
  })

  it('cleanup() removes the run dir', () => {
    const cfg = synth()
    expect(fs.existsSync(cfg.configDir)).toBe(true)
    cfg.cleanup()
    expect(fs.existsSync(cfg.configDir)).toBe(false)
  })

  it('rejects a traversal runId before touching the filesystem', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-'))
    tmpDirs.push(dataDir)
    expect(() =>
      synthesizeConfigDir(DEFAULT_PROFILE, { runId: '../escape', dataDir, assetsDir: ASSET_DIR }),
    ).toThrow(/unsafe runId/)
  })

  it('rejects a traversal charter before reading assets', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-'))
    tmpDirs.push(dataDir)
    // deliberately invalid (simulates an untyped DB value) — cast past CharterName
    const evil = { ...DEFAULT_PROFILE, charter: '../../secret' as unknown as CharterName }
    expect(() =>
      synthesizeConfigDir(evil, { runId: 'run-x', dataDir, assetsDir: ASSET_DIR }),
    ).toThrow(/unsafe charter/)
  })
})

describe('bundle-driven mounting + kstore wiring (Wave 6)', () => {
  /** Synthesize as a given charter tier (DEFAULT_PROFILE is orchestrator). */
  function synthAs(charterTier: CharterName) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-'))
    tmpDirs.push(dataDir)
    const runId = 'run-' + Math.random().toString(36).slice(2)
    const profile = { ...DEFAULT_PROFILE, tier: charterTier, charter: charterTier }
    const cfg = synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
    return { cfg, dataDir, runId }
  }
  const dirNames = (root: string): string[] =>
    fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
      : []
  const agentNames = (configDir: string): string[] => {
    const dir = path.join(configDir, 'agents')
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')).sort()
      : []
  }

  it('orchestrator mounts the full skill set AND the worker-agent roster', () => {
    const { cfg } = synthAs('orchestrator')
    const skills = dirNames(path.join(cfg.configDir, 'skills'))
    expect(skills).toContain('gitnexus')
    expect(skills).toContain('subagent-driven-development')
    expect(agentNames(cfg.configDir)).toEqual([
      'debugger',
      'implementer',
      'planner',
      'quality-reviewer',
      'security-reviewer',
      'spec-reviewer',
    ])
  })

  it('secretary mounts ONLY its bundle skills and NO worker-agents', () => {
    const { cfg } = synthAs('secretary')
    const skills = dirNames(path.join(cfg.configDir, 'skills')).sort()
    expect(skills).toEqual([
      'capturing-lessons',
      'iterative-retrieval',
      'search-first',
      'strategic-compact',
    ])
    expect(skills).not.toContain('gitnexus')
    expect(skills).not.toContain('test-driven-development')
    expect(agentNames(cfg.configDir)).toEqual([])
  })

  it('chief mounts exactly its bundle skills (incl. gitnexus) but NO worker-agents', () => {
    const { cfg } = synthAs('chief')
    expect(dirNames(path.join(cfg.configDir, 'skills')).sort()).toEqual([
      'capturing-lessons',
      'gitnexus',
      'iterative-retrieval',
      'search-first',
      'strategic-compact',
    ])
    expect(agentNames(cfg.configDir)).toEqual([])
  })

  it('rejects a safe-but-unknown charter (allowlist guard)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-'))
    tmpDirs.push(dataDir)
    const profile = { ...DEFAULT_PROFILE, charter: 'wizard' as unknown as CharterName }
    expect(() =>
      synthesizeConfigDir(profile, { runId: 'run-x', dataDir, assetsDir: ASSET_DIR }),
    ).toThrow(/unknown charter/)
  })

  it('rewrites the kstore MCP server: real node command/args + injected K_DATA_DIR/K_RUN_ID, no placeholders left', () => {
    const { cfg, dataDir, runId } = synthAs('orchestrator')
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8'))
    // No placeholder survives in the actual server config (the descriptive _note
    // may still name them — scan the resolved servers, not the whole file).
    const servers = JSON.stringify(mcp.mcpServers)
    expect(servers).not.toContain('__KSTORE__')
    expect(servers).not.toContain('__K_DATA_DIR__')
    expect(servers).not.toContain('__K_RUN_ID__')
    const k = mcp.mcpServers.kstore
    expect(k.command).toBe(process.execPath)
    const args = k.args as string[]
    // dev launch: node --import <absolute tsx loader> <abs serverPath>
    expect(args).toContain('--import')
    expect(args[args.length - 1].replace(/\\/g, '/')).toMatch(/\/mcp\/k-store-server\.(ts|js)$/)
    // the tsx loader is pinned to an absolute path, never the bare specifier
    const loader = args[args.indexOf('--import') + 1]
    expect(loader).not.toBe('tsx')
    expect(loader.startsWith('file://')).toBe(true)
    expect(k.env.K_DATA_DIR).toBe(dataDir)
    expect(k.env.K_RUN_ID).toBe(runId)
    // gitnexus passes through untouched
    expect(mcp.mcpServers.gitnexus.command).toBe('npx')
  })

  it('secretary mcp carries a rewritten kstore AND logistics bound to its run', () => {
    const { cfg, runId } = synthAs('secretary')
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8'))
    expect(mcp.mcpServers.kstore.env.K_RUN_ID).toBe(runId)
    expect(mcp.mcpServers.kstore.command).toBe(process.execPath)
    expect(mcp.mcpServers.logistics.env.K_RUN_ID).toBe(runId)
    expect(mcp.mcpServers.logistics.command).toBe(process.execPath)
  })
})

describe('pruneOrphanAgentRuns', () => {
  it('removes agent-run dirs not in activeRunIds and keeps the active ones', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-prune-'))
    tmpDirs.push(dataDir)
    fs.mkdirSync(path.join(dataDir, 'agent-runs', 'a', 'config'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'agent-runs', 'b', 'config'), { recursive: true })

    pruneOrphanAgentRuns(new Set(['a']), dataDir)

    expect(fs.existsSync(path.join(dataDir, 'agent-runs', 'a'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'agent-runs', 'b'))).toBe(false)
  })

  it('does not throw when agent-runs/ is absent', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-prune-'))
    tmpDirs.push(dataDir)
    expect(() => pruneOrphanAgentRuns(new Set(['x']), dataDir)).not.toThrow()
  })
})

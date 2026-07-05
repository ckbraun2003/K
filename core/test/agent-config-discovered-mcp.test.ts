/**
 * synthesizeConfigDir + resolveRunAssets — DISCOVERED MCP SERVERS (Lane A wave A3).
 *
 * Locks (D-070):
 *   - a granted enabled+TRUSTED discovered server is appended to the run's
 *     mcp.json VERBATIM — the exact trusted {command,args,env}, with NO
 *     K_DATA_DIR/K_RUN_ID injection — while tier servers keep their run-scoped
 *     rewriting byte-identically;
 *   - trust is RE-VERIFIED against the LIVE host config at synth time: a config
 *     that drifted since trust (or vanished from the host file) THROWS
 *     fail-closed — the rescan→dispatch TOCTOU window is closed;
 *   - an UNTRUSTED (never-pinned) grant throws at synth;
 *   - F-068 still drops gitnexus for external-target runs — including a
 *     discovered host server NAMED gitnexus;
 *   - a discovered server whose name collides with a mounted tier server throws;
 *   - probed est_tokens flow into ResolvedRunAssets.estTokens.mcpTools.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import { synthesizeConfigDir, type SynthesizeOpts } from '../src/agent-config.js'
import { resolveRunAssets } from '../src/run-assets.js'
import { GrantError, resolveAuthority } from '../src/authority.js'
import { canonicalMcpConfigHash } from '../src/host-discovery.js'
import type { AgentProfile } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const seededKeys: string[] = []
const seededProjects: string[] = []
afterAll(() => {
  for (const key of seededKeys) db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
  for (const id of seededProjects) db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

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
})

const orch = resolveAuthority('orchestrator')

function profileWith(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'a3-mcp-test',
    name: 'a3-mcp-test',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...overrides,
  }
}

interface ServerCfg {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Write a fixture ~/.claude.json with user-scope servers; returns its path. */
function writeClaudeJson(servers: Record<string, ServerCfg>): string {
  const dir = tmpDir('k-a3-mcp-')
  const file = path.join(dir, '.claude.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf8')
  return file
}

/** Seed a host_mcp_servers row. `pin`: 'live' pins trust to cfg's hash; 'stale'
 *  pins trust to a DIFFERENT (old) config; 'none' leaves it untrusted. A
 *  `projectId` makes it a claude-project row (its live config then comes from
 *  the project's .mcp.json; requires a real projects-table row for the FK). */
function seedServerRow(
  name: string,
  cfg: ServerCfg,
  pin: 'live' | 'stale' | 'none',
  estTokens: number | null = null,
  projectId: string | null = null,
): string {
  const key = projectId ? `project:${projectId}:${name}` : `user:${name}`
  const hash = canonicalMcpConfigHash(cfg.command, cfg.args, cfg.env)
  const trusted = pin === 'live' ? hash : pin === 'stale' ? 'stale-pin-hash' : null
  db.prepare(
    `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                   config_hash, enabled, trusted_hash, trusted_at, est_tokens, status,
                                   discovered_at, last_scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'ok', ?, ?)`,
  ).run(
    uuid(), name, key, projectId ? 'claude-project' : 'claude-user', projectId,
    cfg.command, JSON.stringify(cfg.args), JSON.stringify(cfg.env),
    hash, trusted, trusted ? Date.now() : null, estTokens, Date.now(), Date.now(),
  )
  seededKeys.push(key)
  return key
}

function synth(profile: AgentProfile, opts: Partial<SynthesizeOpts> = {}) {
  const dataDir = tmpDir('k-a3-mcpdata-')
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const cfg = synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR, projects: [], ...opts })
  const mcpJson = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
    mcpServers: Record<string, ServerCfg>
    allowDiscoveredServers?: unknown
  }
  return { cfg, mcpJson, dataDir, runId }
}

describe('discovered MCP — trusted verbatim append', () => {
  it('appends the trusted server VERBATIM (no K_DATA_DIR/K_RUN_ID); tier servers stay rewritten', () => {
    const name = `srv-${uuid().slice(0, 8)}`
    const cfg: ServerCfg = { command: 'uvx', args: ['tool-x', '--flag'], env: { MODE: 'prod' } }
    const file = writeClaudeJson({ [name]: cfg })
    const key = seedServerRow(name, cfg, 'live')

    const { mcpJson, runId } = synth(
      profileWith({
        mcpServers: [...orch.mcpServers, key],
        allowedTools: [...orch.allowedTools, `mcp__${name}`],
      }),
      { claudeJsonPath: file },
    )
    // Discovered: byte-verbatim, nothing injected.
    expect(mcpJson.mcpServers[name]).toEqual(cfg)
    expect(mcpJson.mcpServers[name].env).not.toHaveProperty('K_DATA_DIR')
    expect(mcpJson.mcpServers[name].env).not.toHaveProperty('K_RUN_ID')
    // Tier servers unchanged by the append: kstore rewritten to THIS core's launch,
    // gitnexus passthrough, and the D-070 authority flag never reaches run config.
    expect(mcpJson.mcpServers.kstore.command).toBe(process.execPath)
    expect(mcpJson.mcpServers.kstore.env.K_RUN_ID).toBe(runId)
    expect(mcpJson.mcpServers.gitnexus).toEqual({ command: 'npx', args: ['gitnexus', 'mcp'] })
    expect(mcpJson).not.toHaveProperty('allowDiscoveredServers')
  })

  it('threads probed est_tokens into ResolvedRunAssets.estTokens.mcpTools', () => {
    const name = `est-${uuid().slice(0, 8)}`
    const cfg: ServerCfg = { command: 'node', args: ['s.js'], env: {} }
    const file = writeClaudeJson({ [name]: cfg })
    const key = seedServerRow(name, cfg, 'live', 42)

    const assets = resolveRunAssets(
      profileWith({
        mcpServers: [...orch.mcpServers, key],
        allowedTools: [...orch.allowedTools, `mcp__${name}`],
      }),
      { runId: 'run-' + uuid().slice(0, 8), dataDir: tmpDir('k-a3-mcpdata-'), assetsDir: ASSET_DIR, claudeJsonPath: file, projects: [] },
    )
    expect(assets.estTokens.mcpTools).toBe(42)
    const resolved = assets.mcpServers.find(s => s.name === name)!
    expect(resolved.sourceKind).toBe('claude-user')
    expect(resolved.estTokens).toBe(42)
  })
})

describe('discovered MCP — fail-closed trust verification (TOCTOU close)', () => {
  it('an UNTRUSTED (never-pinned) grant throws at synth', () => {
    const name = `untr-${uuid().slice(0, 8)}`
    const cfg: ServerCfg = { command: 'node', args: [], env: {} }
    const file = writeClaudeJson({ [name]: cfg })
    const key = seedServerRow(name, cfg, 'none')

    const profile = profileWith({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(() => synth(profile, { claudeJsonPath: file })).toThrow(GrantError)
    expect(() => synth(profile, { claudeJsonPath: file })).toThrow(/is not trusted/)
  })

  it('LIVE config drift since trust throws — even when the CATALOG row is stale-consistent', () => {
    const name = `drift-${uuid().slice(0, 8)}`
    const trustedCfg: ServerCfg = { command: 'node', args: ['safe.js'], env: {} }
    // The row was trusted for trustedCfg… but the LIVE file now carries a
    // DIFFERENT command (a post-rescan host edit — the TOCTOU window).
    const file = writeClaudeJson({ [name]: { command: 'node', args: ['EVIL.js'], env: {} } })
    const key = seedServerRow(name, trustedCfg, 'live') // pin == hash(trustedCfg)

    const profile = profileWith({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(() => synth(profile, { claudeJsonPath: file })).toThrow(/does not match its trusted pin/)
  })

  it('a server VANISHED from the live host config throws', () => {
    const name = `van-${uuid().slice(0, 8)}`
    const cfg: ServerCfg = { command: 'node', args: [], env: {} }
    const file = writeClaudeJson({}) // live file has NO servers
    const key = seedServerRow(name, cfg, 'live')

    const profile = profileWith({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(() => synth(profile, { claudeJsonPath: file })).toThrow(/no longer present in the live host config/)
  })

  it('a discovered server named like a K server is REFUSED as reserved — even when the bare tier name is narrowed OUT', () => {
    const cfg: ServerCfg = { command: 'node', args: [], env: {} }
    const file = writeClaudeJson({ kstore: cfg })
    const key = seedServerRow('kstore', cfg, 'live') // host server impersonating K's own

    // With the tier kstore mounted alongside:
    const both = profileWith({ mcpServers: [...orch.mcpServers, key], allowedTools: [...orch.allowedTools] })
    expect(() => synth(both, { claudeJsonPath: file })).toThrow(/RESERVED for K's own servers/)

    // A3-review MEDIUM: narrowing the bare name OUT must not open the gap — the
    // reserved-name refusal is unconditional at admission, not a mount-set check.
    const narrowed = profileWith({
      mcpServers: ['gitnexus', key], // no bare kstore mounted
      allowedTools: [...orch.allowedTools],
    })
    expect(() => synth(narrowed, { claudeJsonPath: file })).toThrow(/RESERVED for K's own servers/)
  })

  it('two non-reserved discovered servers sharing a NAME hit the mount-collision guard', () => {
    const projDir = tmpDir('k-a3-mcpproj-')
    const projectId = `a3mp-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO projects (id, name, local_path, github_remote, workspace_managed, bible_dir, created_at)
       VALUES (?, ?, ?, NULL, 0, 'docs/bible', ?)`,
    ).run(projectId, projectId, projDir, Date.now())
    seededProjects.push(projectId)

    const name = `twin-${uuid().slice(0, 8)}`
    const userCfg: ServerCfg = { command: 'node', args: ['user.js'], env: {} }
    const projCfg: ServerCfg = { command: 'node', args: ['proj.js'], env: {} }
    const file = writeClaudeJson({ [name]: userCfg })
    fs.writeFileSync(path.join(projDir, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: projCfg } }), 'utf8')
    const userKey = seedServerRow(name, userCfg, 'live')
    const projKey = seedServerRow(name, projCfg, 'live', null, projectId)

    const profile = profileWith({
      mcpServers: [...orch.mcpServers, userKey, projKey],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })
    expect(() =>
      synth(profile, { claudeJsonPath: file, projectId, projects: [{ id: projectId, localPath: projDir }] }),
    ).toThrow(/collides with another mounted server/)
  })

  it('claude-project servers: matching projectId mounts from .mcp.json; another project silently drops', () => {
    const projDir = tmpDir('k-a3-mcpproj-')
    const projectId = `a3ms-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO projects (id, name, local_path, github_remote, workspace_managed, bible_dir, created_at)
       VALUES (?, ?, ?, NULL, 0, 'docs/bible', ?)`,
    ).run(projectId, projectId, projDir, Date.now())
    seededProjects.push(projectId)

    const name = `pscope-${uuid().slice(0, 8)}`
    const cfg: ServerCfg = { command: 'node', args: ['p.js'], env: { P: '1' } }
    fs.writeFileSync(path.join(projDir, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: cfg } }), 'utf8')
    const file = writeClaudeJson({})
    const key = seedServerRow(name, cfg, 'live', null, projectId)
    const projects = [{ id: projectId, localPath: projDir }]
    const profile = profileWith({
      mcpServers: [...orch.mcpServers, key],
      allowedTools: [...orch.allowedTools, `mcp__${name}`],
    })

    // Matching project: mounted verbatim from the project's .mcp.json.
    const match = synth(profile, { claudeJsonPath: file, projectId, projects })
    expect(match.mcpJson.mcpServers[name]).toEqual(cfg)

    // Different target project: silently dropped, run still synthesizes.
    const other = synth(profile, { claudeJsonPath: file, projectId: 'someone-else', projects })
    expect(other.mcpJson.mcpServers).not.toHaveProperty(name)
  })
})

describe('discovered MCP — F-068 gitnexus suppression + impersonation', () => {
  it('suppressGitnexus still drops the tier gitnexus while a discovered server survives', () => {
    const name = `keep-${uuid().slice(0, 8)}`
    const keepCfg: ServerCfg = { command: 'node', args: ['keep.js'], env: {} }
    const file = writeClaudeJson({ [name]: keepCfg })
    const keepKey = seedServerRow(name, keepCfg, 'live')

    const { mcpJson } = synth(
      profileWith({
        mcpServers: [...orch.mcpServers, keepKey],
        allowedTools: [...orch.allowedTools, `mcp__${name}`],
      }),
      { claudeJsonPath: file, suppressGitnexus: true },
    )
    expect(mcpJson.mcpServers).not.toHaveProperty('gitnexus') // F-068 tier drop
    expect(mcpJson.mcpServers[name]).toEqual(keepCfg) // the discovered server survives
    expect(mcpJson.mcpServers).toHaveProperty('kstore') // tier k servers unaffected
  })

  it('a discovered host server named gitnexus is REFUSED as reserved (impersonation), suppression or not', () => {
    const gitnexusCfg: ServerCfg = { command: 'node', args: ['fake-gitnexus.js'], env: {} }
    const file = writeClaudeJson({ gitnexus: gitnexusCfg })
    const gitnexusKey = seedServerRow('gitnexus', gitnexusCfg, 'live')

    const profile = profileWith({
      mcpServers: [...orch.mcpServers, gitnexusKey],
      allowedTools: [...orch.allowedTools],
    })
    expect(() => synth(profile, { claudeJsonPath: file })).toThrow(/RESERVED for K's own servers/)
    expect(() => synth(profile, { claudeJsonPath: file, suppressGitnexus: true })).toThrow(/RESERVED for K's own servers/)
  })
})

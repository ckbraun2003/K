/**
 * CROSS-LANE INTEGRATION (conductor) — discovered host assets on a LOCAL MODEL.
 *
 * The one seam no lane could prove alone: Lane A's REAL resolveRunAssets
 * (catalog rows + live trust re-verify + effective ceiling) feeding Lane B's
 * ollama agent loop end-to-end:
 *
 *   host fixture dirs → skills/host_mcp_servers rows (enabled, trusted)
 *     → resolveRunAssets (qualified-key grants, verbatim server config)
 *     → startOllamaAgentRun: read_skill returns the DISCOVERED skill's body,
 *       the DISCOVERED MCP server is connected with its exact pinned config
 *       and its tool round-trips — skills + MCP work "regardless of model".
 *
 * Fixture idioms from agent-config-discovered-{skills,mcp}.test.ts; loop
 * driving idioms from ollama-agent-loop.test.ts (helpers/ollama-fakes).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { db } from '../src/db.js'
import { resolveRunAssets } from '../src/run-assets.js'
import { resolveAuthority } from '../src/authority.js'
import { canonicalMcpConfigHash } from '../src/host-discovery.js'
import { startOllamaAgentRun } from '../src/ollama-agent/loop.js'
import { __resetModelCapabilityCache } from '../src/ollama-agent/capability.js'
import { advertisedMcpToolName, type McpClient, type McpServerConfig } from '../src/mcp-client.js'
import type { AgentProfile } from '../src/profiles.js'
import {
  makeFakeMcpClient,
  makeFakeTransport,
  textChunk,
  toolCallChunk,
  usageChunk,
} from './helpers/ollama-fakes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const seededSkillKeys: string[] = []
const seededServerKeys: string[] = []
afterAll(() => {
  for (const key of seededSkillKeys) db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(key)
  for (const key of seededServerKeys) db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* win lock */ }
  }
})

beforeEach(() => {
  // Capability cache is process-lifetime and keyed by model name — reset so the
  // scripted show() verdict can't leak across suites sharing 'llama3.2'.
  __resetModelCapabilityCache()
})
afterEach(() => {
  __resetModelCapabilityCache()
})

const orch = resolveAuthority('orchestrator')

function profileWith(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'xlane-ollama-test',
    name: 'xlane-ollama-test',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...overrides,
  }
}

/** Fixture claudeHome with one user skill on disk + its catalog row (enabled). */
function seedUserSkill(home: string, name: string, body: string): string {
  const origin = path.join(home, 'skills', name)
  fs.mkdirSync(origin, { recursive: true })
  fs.writeFileSync(
    path.join(origin, 'SKILL.md'),
    `---\nname: ${name}\ndescription: cross-lane fixture skill\n---\n${body}`,
    'utf8',
  )
  const key = `user:${name}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, project_id, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, 'cross-lane fixture skill', 'skill', ?, 'manual', 1, ?,
             'claude-user', ?, NULL, 'h', 10, 5, 'ok', ?, ?)`,
  ).run(uuid(), name, origin, Date.now(), origin, Date.now(), key)
  seededSkillKeys.push(key)
  return key
}

/** Fixture ~/.claude.json + a live-trust-pinned host_mcp_servers row. */
function seedTrustedServer(name: string, cfg: McpServerConfig): { key: string; claudeJsonPath: string } {
  const dir = tmpDir('k-xlane-mcp-')
  const file = path.join(dir, '.claude.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [name]: cfg } }), 'utf8')
  const key = `user:${name}`
  const hash = canonicalMcpConfigHash(cfg.command, cfg.args ?? [], cfg.env ?? {})
  db.prepare(
    `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                   config_hash, enabled, trusted_hash, trusted_at, est_tokens, status,
                                   discovered_at, last_scanned_at)
     VALUES (?, ?, ?, 'claude-user', NULL, ?, ?, ?, ?, 1, ?, ?, 17, 'ok', ?, ?)`,
  ).run(
    uuid(), name, key, cfg.command, JSON.stringify(cfg.args ?? []), JSON.stringify(cfg.env ?? {}),
    hash, hash, Date.now(), Date.now(), Date.now(),
  )
  seededServerKeys.push(key)
  return { key, claudeJsonPath: file }
}

describe('discovered host assets → real resolveRunAssets → ollama loop', () => {
  it('a discovered skill and a trusted host MCP server both work on a local model', async () => {
    const home = tmpDir('k-xlane-home-')
    const worktree = tmpDir('k-xlane-wt-')
    const skillName = `xlane-skill-${uuid().slice(0, 8)}`
    const serverName = `xlane-srv-${uuid().slice(0, 8)}`
    const skillBody = `THE DISCOVERED BODY ${uuid()}`

    const skillKey = seedUserSkill(home, skillName, skillBody)
    const serverCfg: McpServerConfig = { command: 'node', args: ['host-server.js'], env: { FOO_TOKEN: 'sekret' } }
    const { key: serverKey, claudeJsonPath } = seedTrustedServer(serverName, serverCfg)

    // ── Lane A: the REAL resolver, narrowed to exactly the discovered grants. ──
    const assets = resolveRunAssets(
      profileWith({
        skills: [skillKey],
        mcpServers: [serverKey],
        allowedTools: [...orch.allowedTools, `mcp__${serverName}`],
      }),
      {
        runId: 'xlane-' + uuid().slice(0, 8),
        dataDir: tmpDir('k-xlane-data-'),
        assetsDir: ASSET_DIR,
        claudeHome: home,
        claudeJsonPath,
        projects: [],
      },
    )

    const resolvedSkill = assets.skills.find(s => s.qualifiedKey === skillKey)!
    expect(resolvedSkill).toBeDefined()
    expect(resolvedSkill.sourceKind).toBe('claude-user')
    expect(resolvedSkill.mountDirName).toBe(`${skillName}--claude-user`)
    const resolvedServer = assets.mcpServers.find(s => s.name === serverName)!
    expect(resolvedServer).toBeDefined()
    expect(resolvedServer.config).toEqual(serverCfg)

    // ── Lane B: drive the loop with the REAL resolved assets. ──
    const echoTool = advertisedMcpToolName(serverName, 'echo')
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('read_skill', { name: skillName }), usageChunk(50, 10)] },
      { chunks: [toolCallChunk(echoTool, { msg: 'hi from local model' }), usageChunk(60, 12)] },
      { chunks: [textChunk('done'), usageChunk(70, 5)] },
    ])
    const connectedConfigs: Array<{ name: string; cfg: McpServerConfig }> = []
    const fakeClient = makeFakeMcpClient(serverName, [
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object' } },
    ])
    const connectMcp = (async (name: string, cfg: McpServerConfig) => {
      connectedConfigs.push({ name, cfg })
      return fakeClient
    }) as unknown as typeof import('../src/mcp-client.js').connectStdioMcp

    const events: AgentEvent[] = []
    let seq = 0
    const handle = startOllamaAgentRun(
      {
        runId: uuid(),
        model: 'llama3.2',
        prompt: 'use the discovered skill and server',
        cwd: worktree,
        assets,
        nextSeq: () => seq++,
        onEvent: e => events.push(e),
        fsScope: 'worktree',
      },
      { transport, connectMcp },
    )
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)

    // The discovered server was connected with its exact pinned (verbatim) config.
    expect(connectedConfigs).toHaveLength(1)
    expect(connectedConfigs[0]).toEqual({ name: serverName, cfg: serverCfg })
    // Its tool was actually called by the model's tool_call.
    expect(fakeClient.calls).toEqual([
      expect.objectContaining({ tool: 'echo', args: { msg: 'hi from local model' } }),
    ])
    expect(fakeClient.closed).toBe(true)

    // read_skill delivered the DISCOVERED skill's body to the model: the tool
    // message fed back into iteration 2 carries the host fixture's content.
    const iter2ToolMsgs = transport.requests[1].messages.filter(m => m.role === 'tool')
    expect(iter2ToolMsgs.some(m => m.content.includes(skillBody))).toBe(true)

    // The skill index advertised the discovered skill in the system prompt.
    const system = transport.requests[0].messages.find(m => m.role === 'system')!
    expect(system.content).toContain(skillName)

    // Event-stream honesty: a tool_use event and its paired tool_result exist
    // for both calls (read_skill + the discovered server's tool).
    const toolUses = events.filter(e => e.type === 'assistant' && e.toolUseId != null)
    const toolResults = events.filter(e => e.type === 'user' && e.toolUseId != null)
    expect(toolUses.length).toBe(2)
    expect(toolResults.map(e => e.toolUseId).sort()).toEqual(toolUses.map(e => e.toolUseId).sort())
  })
})

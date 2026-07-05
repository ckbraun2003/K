/**
 * Capabilities routes — the D-069/D-070 unified capability catalog API.
 *
 *   GET  /api/capabilities/skills        full catalog (k + discovered) → CatalogSkillsResponse
 *   GET  /api/capabilities/mcp           tier-template servers (provenance 'k', born
 *                                        trusted, not toggleable) + host rows → CatalogMcpResponse
 *   GET  /api/capabilities/hooks         READ-ONLY hook visibility (host + plugin + K) —
 *                                        K runs execute ONLY K's vendored hooks
 *   GET  /api/capabilities/summary       enabled-set token totals + per-source counts
 *   POST /api/capabilities/rescan        syncHostDiscovery → RescanResult + WS capabilities_update
 *   PATCH /api/capabilities/skills/:id   {enabled} — the K-scoped overlay → updated CatalogSkill
 *   PATCH /api/capabilities/mcp/:id      {enabled} — enabling requires trust+ok → updated CatalogMcpServer
 *   POST /api/capabilities/mcp/:id/trust {enable?} — pins trusted_hash=config_hash → updated CatalogMcpServer
 *   POST /api/capabilities/mcp/:id/probe initialize + tools/list via the MCP SDK (15s hard
 *                                        timeout + kill) → updated CatalogMcpServer; failure
 *                                        → 502 {error} (probe_status='failed', NEVER disables)
 *
 * Contract notes (cross-lane, frozen):
 *   - every mutation returns the UPDATED catalog object (the web client re-renders from it);
 *   - `:id` is the URL-ENCODED qualified key (contains ':'/'@') — Fastify decodes path
 *     params once; we never decode again;
 *   - error bodies use the shared { error } envelope (http-errors.ts) — surfaced verbatim;
 *   - env VALUES never leave core: list/mutation payloads carry env NAMES only (inside
 *     commandSummary — the frozen CatalogMcpServer shape has no env field at all);
 *   - D-069 fail-closed at PATCH: enabling a status='missing' asset is a 400.
 *
 * Probe tool counts: the host_mcp_servers table (schema v7, frozen) has no tool_count
 * column, so the probed count persists as app_config `capabilities.probe.<key>` JSON —
 * the projection reads it back so GET stays consistent after a probe.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  CatalogSkill,
  CatalogSkillsResponse,
  CatalogMcpServer,
  CatalogMcpResponse,
  CatalogHook,
  CatalogHooksResponse,
  CatalogWarning,
  CapabilitySummary,
  SkillSourceKind,
} from '@k/shared'
import { db, configDb } from '../db.js'
import { eventBus } from '../events.js'
import { isPathWithin } from '../paths.js'
import { listProfiles } from '../profiles.js'
import { estimateTokens } from '../token-estimate.js'
import {
  syncHostDiscovery,
  readLastRescanResult,
  getCatalogSkillRow,
  getHostMcpServerRow,
} from '../host-discovery.js'
import { sendError, sendZodError } from './http-errors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// routes/ sits one level below src/ — repo-root agent-config/ is three up.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../../agent-config')
const TIERS = ['orchestrator', 'chief', 'secretary'] as const

// ── statements (module-scope; routes evaluate after db.ts settles) ────────────
const listAllSkillRows = db.prepare(`SELECT * FROM skills ORDER BY name COLLATE NOCASE, qualified_key`)
const setSkillEnabledByKey = db.prepare(`UPDATE skills SET enabled = ? WHERE qualified_key = ?`)
const listHostMcpRows = db.prepare(`SELECT * FROM host_mcp_servers ORDER BY name COLLATE NOCASE, qualified_key`)
const setMcpEnabledByKey = db.prepare(`UPDATE host_mcp_servers SET enabled = ? WHERE qualified_key = ?`)
const pinMcpTrust = db.prepare(`UPDATE host_mcp_servers SET trusted_hash = config_hash, trusted_at = ? WHERE qualified_key = ?`)
const setMcpProbeResult = db.prepare(`UPDATE host_mcp_servers SET est_tokens = ?, probe_status = ? WHERE qualified_key = ?`)

// ── projections ───────────────────────────────────────────────────────────────

/** key → referencing profile ids, built ONCE per request (not per catalog row —
 *  A4 review LOW-1: listProfiles re-parses every profile row on each call). */
interface MountIndex {
  skills: Map<string, string[]>
  servers: Map<string, string[]>
}

function buildMountIndex(): MountIndex {
  const skills = new Map<string, string[]>()
  const servers = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, key: string, id: string): void => {
    const ids = map.get(key)
    if (ids) ids.push(id)
    else map.set(key, [id])
  }
  for (const p of listProfiles()) {
    for (const s of p.skills) add(skills, s, p.id)
    for (const m of p.mcpServers) add(servers, m, p.id)
  }
  return { skills, servers }
}

function rowToCatalogSkill(row: Record<string, unknown>, mounts: MountIndex): CatalogSkill {
  const key = String(row.qualified_key)
  const pluginId = row.plugin_id != null ? String(row.plugin_id) : null
  return {
    id: key,
    name: String(row.name),
    description: row.description != null ? String(row.description) : null,
    sourceKind: String(row.source_kind) as SkillSourceKind,
    pluginName: pluginId ? pluginId.split('@')[0] : null,
    // k-native automation rows have no origin_path — their `source` (repo-relative
    // path or inline text) is the honest provenance display.
    path: row.origin_path != null ? String(row.origin_path) : String(row.source),
    enabled: Number(row.enabled) === 1,
    estTokens: row.est_tokens != null ? Number(row.est_tokens) : null,
    estTokensMeta: row.est_tokens_meta != null ? Number(row.est_tokens_meta) : null,
    modelCompat: 'universal', // v1 default — refinement is a catalog follow-up
    mountedBy: mounts.skills.get(key) ?? [],
    status: row.status === 'missing' ? 'missing' : 'ok',
    updatedAt: row.last_scanned_at != null ? Number(row.last_scanned_at) : null,
  }
}

/** Probed tool count for a host server (app_config sidecar — see module header).
 *  Honored ONLY when the sidecar's recorded configHash matches the row's CURRENT
 *  config_hash: a drifted config or a reused qualified key can never surface the
 *  count probed from a DIFFERENT server config (A4 review M-1). */
function probedToolCount(key: string, currentConfigHash: string): number | null {
  const raw = configDb.get(`capabilities.probe.${key}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { toolCount?: unknown; configHash?: unknown }
    if (parsed.configHash !== currentConfigHash) return null
    return typeof parsed.toolCount === 'number' ? parsed.toolCount : null
  } catch {
    return null
  }
}

/** command + args + env NAMES — values never leave core (D-070). */
function summarizeCommand(command: string, args: string[], envNames: string[]): string {
  const base = `${command} ${args.join(' ')}`.trim()
  return envNames.length ? `${base} [env: ${envNames.join(', ')}]` : base
}

function rowToCatalogMcp(row: Record<string, unknown>, mounts: MountIndex): CatalogMcpServer {
  const key = String(row.qualified_key)
  let args: string[] = []
  let envNames: string[] = []
  try { args = JSON.parse(String(row.args ?? '[]')) as string[] } catch { /* garbled → [] */ }
  try { envNames = Object.keys(JSON.parse(String(row.env ?? '{}')) as Record<string, unknown>) } catch { /* → [] */ }
  return {
    id: key,
    name: String(row.name),
    sourceKind: String(row.source_kind) as SkillSourceKind,
    pluginName: null,
    transport: 'stdio', // v1 discovers stdio servers only
    commandSummary: summarizeCommand(String(row.command), args, envNames),
    trusted: row.trusted_hash != null && row.trusted_hash === row.config_hash,
    enabled: Number(row.enabled) === 1,
    estTokens: row.est_tokens != null ? Number(row.est_tokens) : null,
    toolCount: probedToolCount(key, String(row.config_hash)),
    mountedBy: mounts.servers.get(key) ?? [],
    status: row.status === 'missing' ? 'missing' : 'ok',
  }
}

interface TierTemplateServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/** The STATIC halves of the k tier-server entries, computed once (the templates
 *  are committed assets — A4 review LOW-3); mountedBy attaches per request. */
let kTierServerStatics: Array<Omit<CatalogMcpServer, 'mountedBy'>> | null = null

function kTierServerStaticList(assetsDir = DEFAULT_ASSETS_DIR): Array<Omit<CatalogMcpServer, 'mountedBy'>> {
  if (kTierServerStatics) return kTierServerStatics
  const seen = new Map<string, Omit<CatalogMcpServer, 'mountedBy'>>()
  for (const tier of TIERS) {
    let template: { mcpServers?: Record<string, TierTemplateServer> }
    try {
      template = JSON.parse(fs.readFileSync(path.join(assetsDir, 'mcp', `${tier}.json`), 'utf8')) as typeof template
    } catch {
      continue // a missing/garbled tier template is a repo fault surfaced elsewhere
    }
    for (const [name, cfg] of Object.entries(template.mcpServers ?? {})) {
      if (seen.has(name)) continue
      const isRunScoped = (cfg.command ?? '').startsWith('__')
      seen.set(name, {
        id: name, // k servers use their bare server name as the wire id
        name,
        sourceKind: 'k',
        pluginName: null,
        transport: 'stdio',
        commandSummary: isRunScoped
          ? 'K-managed run-scoped server (rewritten at dispatch)'
          : summarizeCommand(cfg.command ?? '', cfg.args ?? [], Object.keys(cfg.env ?? {})),
        trusted: true, // born trusted — K's own committed assets
        enabled: true,
        estTokens: null,
        toolCount: null,
        status: 'ok',
      })
    }
  }
  kTierServerStatics = [...seen.values()]
  return kTierServerStatics
}

/** True iff `id` names one of K's own tier-template servers (fast gate check). */
function isKTierServerId(id: string): boolean {
  return kTierServerStaticList().some(s => s.id === id)
}

/** The K tier-template servers, merged across tiers (unique by name). Provenance
 *  'k': born trusted, always enabled, never toggleable/probeable — they are K's
 *  own run-scoped children, rewritten by the synthesizer at dispatch. */
function kTierServers(mounts: MountIndex): CatalogMcpServer[] {
  return kTierServerStaticList().map(s => ({ ...s, mountedBy: mounts.servers.get(s.name) ?? [] }))
}

// ── hooks visibility (read-only) ──────────────────────────────────────────────

interface HookGroup {
  matcher?: string
  hooks?: Array<{ command?: string }>
}

/** Flatten a settings-style hooks object into CatalogHook rows. */
function flattenHooks(
  hooksObj: unknown,
  idPrefix: string,
  sourceKind: SkillSourceKind,
  pluginName: string | null,
  suffix = '',
): CatalogHook[] {
  const out: CatalogHook[] = []
  if (typeof hooksObj !== 'object' || hooksObj === null) return out
  for (const [event, groupsRaw] of Object.entries(hooksObj as Record<string, unknown>)) {
    const groups = Array.isArray(groupsRaw) ? (groupsRaw as HookGroup[]) : []
    groups.forEach((group, gi) => {
      for (const hook of group.hooks ?? []) {
        if (typeof hook?.command !== 'string') continue
        out.push({
          id: `${idPrefix}:${event}:${gi}:${out.length}`,
          sourceKind,
          pluginName,
          event,
          matcher: typeof group.matcher === 'string' ? group.matcher : null,
          commandSummary: `${hook.command}${suffix}`,
        })
      }
    })
  }
  return out
}

export interface ReadHooksOpts {
  claudeHome?: string
  assetsDir?: string
}

/**
 * Read-only hook visibility: K's own settings-template hooks (the ONLY hooks a K
 * run executes — labeled so), the host user settings.json hooks, and each
 * installed plugin's hooks/hooks.json. Every read is tolerant: unreadable or
 * malformed input lands a warning, never a throw. Pure + exported for tests.
 */
export function readCapabilityHooks(opts: ReadHooksOpts = {}): { hooks: CatalogHook[]; warnings: CatalogWarning[] } {
  const claudeHome = opts.claudeHome ?? path.join(os.homedir(), '.claude')
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const hooks: CatalogHook[] = []
  const warnings: CatalogWarning[] = []

  const readJson = (file: string, label: string): Record<string, unknown> | null => {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push({ path: file, message: `[${label}] unreadable — skipped (${(e as Error).message})` })
      }
      return null
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch (e) {
      warnings.push({ path: file, message: `[${label}] unparseable JSON — skipped (${(e as Error).message})` })
      return null
    }
  }

  // K's own hooks — the only ones a K run ever executes (vendored by the synthesizer).
  const template = readJson(path.join(assetsDir, 'settings.template.json'), 'k')
  hooks.push(...flattenHooks(template?.hooks, 'k', 'k', null, ' — mounted by the synthesizer into every run'))

  // Host user hooks — VISIBILITY ONLY (never executed by a K run: the synthesized
  // CLAUDE_CONFIG_DIR replaces the host layer entirely).
  const settings = readJson(path.join(claudeHome, 'settings.json'), 'claude-user')
  hooks.push(...flattenHooks(settings?.hooks, 'user', 'claude-user', null))

  // Plugin hooks — presence via the authoritative v2 index (same source as skill
  // discovery); each plugin's hooks/hooks.json flattened when parseable. The same
  // realpath-under-cache containment as plugin SKILL discovery applies: a
  // poisoned index must not point even a read-only listing at arbitrary disk.
  const index = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'claude-plugin')
  if (index?.version === 2 && typeof index.plugins === 'object' && index.plugins !== null) {
    let realCache: string | null = null
    try {
      realCache = fs.realpathSync(path.join(claudeHome, 'plugins', 'cache'))
    } catch {
      realCache = null
    }
    for (const [pluginId, installsRaw] of Object.entries(index.plugins as Record<string, unknown>)) {
      const installs = Array.isArray(installsRaw) ? installsRaw : []
      for (const entry of installs) {
        const install = (entry ?? {}) as { installPath?: unknown }
        if (typeof install.installPath !== 'string') continue
        let realInstall: string
        try {
          realInstall = fs.realpathSync(install.installPath)
        } catch {
          continue // not on disk — nothing to list
        }
        if (realCache === null || !isPathWithin(realCache, realInstall)) {
          warnings.push({
            path: install.installPath,
            message: `[claude-plugin] plugin "${pluginId}" installPath resolves OUTSIDE the plugin cache — hooks not listed (poisoned index?)`,
          })
          continue
        }
        const hooksJson = readJson(path.join(realInstall, 'hooks', 'hooks.json'), 'claude-plugin')
        if (!hooksJson) continue
        hooks.push(...flattenHooks(hooksJson.hooks, `plugin:${pluginId}`, 'claude-plugin', pluginId.split('@')[0]))
        break // one install per plugin is enough for visibility
      }
    }
  }
  return { hooks, warnings }
}

// ── MCP probe (D-070) ─────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 15_000

type ProbeOutcome = { ok: true; estTokens: number; toolCount: number } | { ok: false; error: string }

/** Spawn the server via the MCP SDK stdio client, initialize + tools/list, hard
 *  15s timeout; the transport is ALWAYS closed (kills the child). Never throws. */
async function probeServer(command: string, args: string[], env: Record<string, string>): Promise<ProbeOutcome> {
  const client = new Client({ name: 'k-capability-probe', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command,
    args,
    // The trusted env rides ON TOP of a default environment (PATH etc.) — the
    // same layering the CLI gives an mcp.json server at run time.
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'ignore',
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const work = (async (): Promise<ProbeOutcome> => {
      await client.connect(transport) // performs the initialize handshake
      const res = await client.listTools()
      const tools = res.tools ?? []
      return { ok: true, estTokens: estimateTokens(JSON.stringify(tools)), toolCount: tools.length }
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)
    })
    return await Promise.race([work, timeout])
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
    try { await client.close() } catch { /* best-effort */ }
    try { await transport.close() } catch { /* close kills the child */ }
  }
}

// ── routes ────────────────────────────────────────────────────────────────────

const EnabledPatchSchema = z.object({ enabled: z.boolean() }).strict()
const TrustBodySchema = z.object({ enable: z.boolean().optional() }).strict()

export async function capabilitiesRoutes(app: FastifyInstance) {
  // GET /api/capabilities/skills — the full catalog (k-native + discovered).
  app.get('/api/capabilities/skills', async (_req, reply) => {
    const last = readLastRescanResult()
    const mounts = buildMountIndex()
    const payload: CatalogSkillsResponse = {
      skills: (listAllSkillRows.all() as Record<string, unknown>[]).map(row => rowToCatalogSkill(row, mounts)),
      scannedAt: last?.scannedAt ?? null,
      warnings: last?.warnings ?? [],
    }
    return reply.send(payload)
  })

  // GET /api/capabilities/mcp — merged k tier servers + discovered host servers.
  app.get('/api/capabilities/mcp', async (_req, reply) => {
    const last = readLastRescanResult()
    const mounts = buildMountIndex()
    const payload: CatalogMcpResponse = {
      servers: [
        ...kTierServers(mounts),
        ...(listHostMcpRows.all() as Record<string, unknown>[]).map(row => rowToCatalogMcp(row, mounts)),
      ],
      scannedAt: last?.scannedAt ?? null,
      warnings: last?.warnings ?? [],
    }
    return reply.send(payload)
  })

  // GET /api/capabilities/hooks — read-only visibility (host hooks are never executed by K).
  app.get('/api/capabilities/hooks', async (_req, reply) => {
    const { hooks, warnings } = readCapabilityHooks()
    const payload: CatalogHooksResponse = {
      hooks,
      scannedAt: readLastRescanResult()?.scannedAt ?? null,
      warnings,
    }
    return reply.send(payload)
  })

  // GET /api/capabilities/summary — the CapabilityStatRow numbers.
  app.get('/api/capabilities/summary', async (_req, reply) => {
    const skillRows = listAllSkillRows.all() as Record<string, unknown>[]
    const mcpRows = listHostMcpRows.all() as Record<string, unknown>[]
    const kServers = kTierServerStaticList()

    const skillSide = { enabledCount: 0, estTokens: 0, unestimatedCount: 0 }
    for (const row of skillRows) {
      if (Number(row.enabled) !== 1) continue
      skillSide.enabledCount++
      if (row.est_tokens != null) skillSide.estTokens += Number(row.est_tokens)
      else skillSide.unestimatedCount++
    }
    // K's own servers are always enabled (born trusted); they carry no estimate
    // until probing exists for them → they count as unestimated, honestly.
    const mcpSide = { enabledCount: kServers.length, estTokens: 0, unestimatedCount: kServers.length }
    for (const row of mcpRows) {
      if (Number(row.enabled) !== 1) continue
      mcpSide.enabledCount++
      if (row.est_tokens != null) mcpSide.estTokens += Number(row.est_tokens)
      else mcpSide.unestimatedCount++
    }

    const perSource: CapabilitySummary['perSource'] = {
      'k': { skills: 0, mcpServers: kServers.length },
      'claude-user': { skills: 0, mcpServers: 0 },
      'claude-project': { skills: 0, mcpServers: 0 },
      'claude-plugin': { skills: 0, mcpServers: 0 },
    }
    for (const row of skillRows) {
      const kind = String(row.source_kind) as SkillSourceKind
      if (perSource[kind]) perSource[kind].skills++
    }
    for (const row of mcpRows) {
      const kind = String(row.source_kind) as SkillSourceKind
      if (perSource[kind]) perSource[kind].mcpServers++
    }

    const payload: CapabilitySummary = {
      skills: skillSide,
      mcp: mcpSide,
      totalEstTokens: skillSide.estTokens + mcpSide.estTokens,
      perSource,
      scannedAt: readLastRescanResult()?.scannedAt ?? null,
    }
    return reply.send(payload)
  })

  // POST /api/capabilities/rescan — run discovery, persist, broadcast, return the result.
  app.post('/api/capabilities/rescan', async (_req, reply) => {
    const result = syncHostDiscovery()
    // Live update: the web client invalidates its ['capabilities'] queries on this.
    eventBus.broadcast({ type: 'capabilities_update', scannedAt: result.scannedAt })
    return reply.send(result)
  })

  // PATCH /api/capabilities/skills/:id — the K-scoped enable overlay.
  app.patch<{ Params: { id: string } }>('/api/capabilities/skills/:id', async (req, reply) => {
    const parsed = EnabledPatchSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const key = req.params.id // Fastify already URL-decoded the param — never double-decode
    const row = getCatalogSkillRow(key)
    if (!row) return sendError(reply, 404, 'not found')
    // D-069 fail-closed at PATCH: a vanished asset cannot be (re-)enabled.
    if (parsed.data.enabled && row.status === 'missing') {
      return sendError(reply, 400, `cannot enable "${key}" — it is missing on the host (rescan or restore it first)`)
    }
    setSkillEnabledByKey.run(parsed.data.enabled ? 1 : 0, key)
    return reply.send(rowToCatalogSkill(getCatalogSkillRow(key)!, buildMountIndex()))
  })

  // PATCH /api/capabilities/mcp/:id — {enabled}; enabling requires trust + ok (D-070).
  app.patch<{ Params: { id: string } }>('/api/capabilities/mcp/:id', async (req, reply) => {
    const parsed = EnabledPatchSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const key = req.params.id
    if (isKTierServerId(key)) {
      return sendError(reply, 400, `"${key}" is one of K's own servers — always on, not toggleable`)
    }
    const row = getHostMcpServerRow(key)
    if (!row) return sendError(reply, 404, 'not found')
    if (parsed.data.enabled) {
      if (row.status === 'missing') {
        return sendError(reply, 400, `cannot enable "${key}" — it is missing on the host (rescan or restore it first)`)
      }
      if (row.trusted_hash == null || row.trusted_hash !== row.config_hash) {
        return sendError(reply, 400, `cannot enable "${key}" — it is not trusted (review and trust it first; enabling requires trust, D-070)`)
      }
    }
    setMcpEnabledByKey.run(parsed.data.enabled ? 1 : 0, key)
    return reply.send(rowToCatalogMcp(getHostMcpServerRow(key)!, buildMountIndex()))
  })

  // POST /api/capabilities/mcp/:id/trust — pin trusted_hash = config_hash (+ optional enable).
  app.post<{ Params: { id: string } }>('/api/capabilities/mcp/:id/trust', async (req, reply) => {
    const parsed = TrustBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const key = req.params.id
    if (isKTierServerId(key)) {
      return sendError(reply, 400, `"${key}" is one of K's own servers — born trusted, nothing to pin`)
    }
    const row = getHostMcpServerRow(key)
    if (!row) return sendError(reply, 404, 'not found')
    if (row.status === 'missing') {
      return sendError(reply, 400, `cannot trust "${key}" — it is missing on the host (there is no live config to pin)`)
    }
    pinMcpTrust.run(Date.now(), key)
    if (parsed.data.enable) setMcpEnabledByKey.run(1, key)
    return reply.send(rowToCatalogMcp(getHostMcpServerRow(key)!, buildMountIndex()))
  })

  // POST /api/capabilities/mcp/:id/probe — token/tool-count probe (enabled+trusted only).
  app.post<{ Params: { id: string } }>('/api/capabilities/mcp/:id/probe', async (req, reply) => {
    const key = req.params.id
    if (isKTierServerId(key)) {
      return sendError(reply, 400, `"${key}" is one of K's own run-scoped servers — not probeable`)
    }
    const row = getHostMcpServerRow(key)
    if (!row) return sendError(reply, 404, 'not found')
    if (Number(row.enabled) !== 1 || row.trusted_hash == null || row.trusted_hash !== row.config_hash) {
      return sendError(reply, 400, `cannot probe "${key}" — probing spawns the server, so it must be trusted AND enabled first`)
    }
    let args: string[] = []
    let env: Record<string, string> = {}
    try { args = JSON.parse(String(row.args ?? '[]')) as string[] } catch { /* garbled → [] */ }
    try { env = JSON.parse(String(row.env ?? '{}')) as Record<string, string> } catch { /* → {} */ }

    const outcome = await probeServer(String(row.command), args, env)
    if (!outcome.ok) {
      // A failed probe is recorded but NEVER disables (D-070) — the operator's
      // enablement stands; the failure is surfaced verbatim for the UI banner.
      setMcpProbeResult.run(row.est_tokens ?? null, 'failed', key)
      return sendError(reply, 502, `probe failed for "${key}" — ${outcome.error}`)
    }
    setMcpProbeResult.run(outcome.estTokens, 'ok', key)
    // The sidecar records the config it measured — the projection honors it only
    // while the row's config_hash still matches (drift/key-reuse safe, M-1).
    configDb.set(
      `capabilities.probe.${key}`,
      JSON.stringify({ toolCount: outcome.toolCount, configHash: String(row.config_hash), at: Date.now() }),
    )
    // The probe awaited for up to 15s — a concurrent rescan may have deleted the
    // row meanwhile. Never let the `!` assertion turn that into a raw 500 (M-2).
    const updated = getHostMcpServerRow(key)
    if (!updated) return sendError(reply, 404, `"${key}" vanished during the probe (concurrent rescan?)`)
    return reply.send(rowToCatalogMcp(updated, buildMountIndex()))
  })
}

/**
 * /api/capabilities/* routes (Lane A wave A4) — catalog projections, the
 * K-scoped enable overlay, rescan + WS broadcast, hooks visibility, summary.
 *
 * Locks:
 *   - GET skills projects EVERY skills row (k + discovered) to the frozen
 *     CatalogSkill shape (id = qualified key; pluginName from plugin_id;
 *     mountedBy = referencing profile ids; k rows path = their source);
 *   - PATCH skills/:id takes the URL-ENCODED qualified key, returns the UPDATED
 *     CatalogSkill (the Lane-C contract), 404s unknown ids, 400s enabling a
 *     status='missing' row (D-069 fail-closed at PATCH);
 *   - GET mcp merges the k tier-template servers (born trusted, always enabled)
 *     with host rows; env VALUES never appear in any payload (names only);
 *   - POST rescan returns the RescanResult and broadcasts WS capabilities_update
 *     (syncHostDiscovery mocked — a route test must never scan the REAL host);
 *   - GET summary math moves with the overlay; GET hooks carries K's own
 *     synthesizer-mounted hooks labeled sourceKind 'k'.
 *
 * Response shapes are Zod-validated with the SHARED schemas so the wire contract
 * can't drift from what Lane C built against.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  CatalogSkillsResponseSchema,
  CatalogSkillSchema,
  CatalogMcpResponseSchema,
  CatalogHooksResponseSchema,
  CapabilitySummarySchema,
  RescanResultSchema,
  type WsMessage,
} from '@k/shared'

// The rescan route must NEVER scan the real host from a test — mock ONLY
// syncHostDiscovery; everything else in the module stays real.
const CANNED_RESCAN = {
  scannedAt: 1234567,
  skills: { discovered: 2, updated: 1, missing: 0 },
  mcpServers: { discovered: 1, updated: 0, missing: 0 },
  warnings: [{ path: '/fake', message: 'canned warning' }],
}
vi.mock('../src/host-discovery.js', async () => {
  const actual = await vi.importActual<typeof import('../src/host-discovery.js')>('../src/host-discovery.js')
  return { ...actual, syncHostDiscovery: vi.fn(() => CANNED_RESCAN) }
})

const { db } = await import('../src/db.js')
const { registerSkill } = await import('../src/skills.js')
const { eventBus } = await import('../src/events.js')
const { readCapabilityHooks } = await import('../src/routes/capabilities.js')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const seededSkillKeys: string[] = []
const seededMcpKeys: string[] = []
const seededProfileIds: string[] = []
const seededSkillIds: string[] = []
const tmpDirs: string[] = []

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function seedDiscoveredSkill(opts: {
  name?: string
  enabled?: 0 | 1
  status?: 'ok' | 'missing'
  pluginId?: string
  estTokens?: number
}): string {
  const name = opts.name ?? `cap-skill-${uuid().slice(0, 8)}`
  const key = opts.pluginId ? `plugin:${opts.pluginId}:${name}` : `user:${name}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, plugin_id, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, 'a discovered skill', 'skill', ?, 'manual', ?, ?, ?, ?, ?, 'h', ?, 3, ?, ?, ?)`,
  ).run(
    uuid(), name, `/host/${name}`, opts.enabled ?? 0, Date.now(),
    opts.pluginId ? 'claude-plugin' : 'claude-user', `/host/${name}`, opts.pluginId ?? null,
    opts.estTokens ?? 10, opts.status ?? 'ok', Date.now(), key,
  )
  seededSkillKeys.push(key)
  return key
}

function seedHostMcp(opts: { name?: string; env?: Record<string, string> }): string {
  const name = opts.name ?? `cap-srv-${uuid().slice(0, 8)}`
  const key = `user:${name}`
  db.prepare(
    `INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                   config_hash, enabled, trusted_hash, trusted_at, status, discovered_at, last_scanned_at)
     VALUES (?, ?, ?, 'claude-user', NULL, 'node', '["srv.js"]', ?, 'hash-x', 0, NULL, NULL, 'ok', ?, ?)`,
  ).run(uuid(), name, key, JSON.stringify(opts.env ?? {}), Date.now(), Date.now())
  seededMcpKeys.push(key)
  return key
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  try {
    for (const key of seededSkillKeys) db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(key)
    for (const id of seededSkillIds) db.prepare(`DELETE FROM skills WHERE id = ?`).run(id)
    for (const key of seededMcpKeys) db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
    for (const id of seededProfileIds) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
  await app.close()
})

describe('GET /api/capabilities/skills', () => {
  it('projects k-native AND discovered rows to the frozen CatalogSkill shape', async () => {
    const kSkill = registerSkill({
      name: `cap-k-${uuid().slice(0, 8)}`,
      type: 'skill',
      source: 'inline prompt text',
      triggerType: 'manual',
    })
    seededSkillIds.push(kSkill.id)
    const pluginKey = seedDiscoveredSkill({ pluginId: 'toolbelt@official', estTokens: 77 })

    const res = await app.inject({ method: 'GET', url: '/api/capabilities/skills', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = CatalogSkillsResponseSchema.parse(res.json()) // wire-contract lock

    const kEntry = body.skills.find(s => s.id === kSkill.name)! // k rows: id == bare name
    expect(kEntry).toMatchObject({
      sourceKind: 'k',
      pluginName: null,
      path: 'inline prompt text',
      enabled: true,
      estTokens: null,
      modelCompat: 'universal',
      status: 'ok',
    })

    const pluginEntry = body.skills.find(s => s.id === pluginKey)!
    expect(pluginEntry).toMatchObject({
      sourceKind: 'claude-plugin',
      pluginName: 'toolbelt', // the plugin half of <plugin>@<marketplace>
      enabled: false, // discovered lands default-disabled
      estTokens: 77,
      estTokensMeta: 3,
    })
  })

  it('mountedBy lists the profiles referencing the qualified key', async () => {
    const key = seedDiscoveredSkill({ enabled: 1 })
    const profId = `cap-prof-${uuid().slice(0, 8)}`
    db.prepare(
      `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
       VALUES (?, ?, 'secretary', 'secretary', '', '[]', '[]', ?, ?)`,
    ).run(profId, profId, JSON.stringify([key]), Date.now())
    seededProfileIds.push(profId)

    const res = await app.inject({ method: 'GET', url: '/api/capabilities/skills', headers: AUTH })
    const body = CatalogSkillsResponseSchema.parse(res.json())
    expect(body.skills.find(s => s.id === key)!.mountedBy).toContain(profId)
  })
})

describe('PATCH /api/capabilities/skills/:id', () => {
  it('toggles the K-scoped overlay via the URL-ENCODED key and returns the updated CatalogSkill', async () => {
    const key = seedDiscoveredSkill({ pluginId: 'toolbelt@official' }) // key contains ':' and '@'
    const url = `/api/capabilities/skills/${encodeURIComponent(key)}`

    const on = await app.inject({ method: 'PATCH', url, headers: AUTH, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    expect(CatalogSkillSchema.parse(on.json())).toMatchObject({ id: key, enabled: true })

    const off = await app.inject({ method: 'PATCH', url, headers: AUTH, payload: { enabled: false } })
    expect(CatalogSkillSchema.parse(off.json())).toMatchObject({ id: key, enabled: false })
  })

  it('404s an unknown id; 400s a bad body; 400s enabling a MISSING row (D-069)', async () => {
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/api/capabilities/skills/${encodeURIComponent('user:no-such-key')}`,
      headers: AUTH,
      payload: { enabled: true },
    })
    expect(unknown.statusCode).toBe(404)

    const key = seedDiscoveredSkill({ status: 'missing' })
    const badBody = await app.inject({
      method: 'PATCH',
      url: `/api/capabilities/skills/${encodeURIComponent(key)}`,
      headers: AUTH,
      payload: { enabled: 'yes' },
    })
    expect(badBody.statusCode).toBe(400)

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/capabilities/skills/${encodeURIComponent(key)}`,
      headers: AUTH,
      payload: { enabled: true },
    })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as { error: string }).error).toMatch(/missing on the host/)
    // …but DISABLING a missing row is always allowed.
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/capabilities/skills/${encodeURIComponent(key)}`,
      headers: AUTH,
      payload: { enabled: false },
    })
    expect(disable.statusCode).toBe(200)
  })
})

describe('GET /api/capabilities/mcp', () => {
  it('merges K tier servers (born trusted, always enabled) with host rows — env VALUES never leave core', async () => {
    seedHostMcp({ env: { SECRET_TOKEN: 'super-secret-value-xyz', PLAIN: 'also-secret' } })

    const res = await app.inject({ method: 'GET', url: '/api/capabilities/mcp', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = CatalogMcpResponseSchema.parse(res.json())

    for (const name of ['gitnexus', 'kstore', 'mgmt', 'logistics']) {
      const k = body.servers.find(s => s.id === name)!
      expect(k, `k server ${name}`).toMatchObject({ sourceKind: 'k', trusted: true, enabled: true, status: 'ok' })
    }
    // env NAMES may appear (trust surface); env VALUES must NEVER.
    const raw = res.body
    expect(raw).toContain('SECRET_TOKEN')
    expect(raw).not.toContain('super-secret-value-xyz')
    expect(raw).not.toContain('also-secret')
  })

  it("K's own servers are not toggleable, trustable, or probeable (400s naming why)", async () => {
    const patch = await app.inject({
      method: 'PATCH', url: '/api/capabilities/mcp/kstore', headers: AUTH, payload: { enabled: false },
    })
    expect(patch.statusCode).toBe(400)
    expect((patch.json() as { error: string }).error).toMatch(/not toggleable/)

    const trust = await app.inject({ method: 'POST', url: '/api/capabilities/mcp/kstore/trust', headers: AUTH, payload: {} })
    expect(trust.statusCode).toBe(400)

    const probe = await app.inject({ method: 'POST', url: '/api/capabilities/mcp/gitnexus/probe', headers: AUTH })
    expect(probe.statusCode).toBe(400)
  })
})

describe('GET /api/capabilities/summary', () => {
  it('validates against the shared schema and moves with the enable overlay', async () => {
    const key = seedDiscoveredSkill({ estTokens: 500 })
    const before = CapabilitySummarySchema.parse(
      (await app.inject({ method: 'GET', url: '/api/capabilities/summary', headers: AUTH })).json(),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/capabilities/skills/${encodeURIComponent(key)}`,
      headers: AUTH,
      payload: { enabled: true },
    })
    const after = CapabilitySummarySchema.parse(
      (await app.inject({ method: 'GET', url: '/api/capabilities/summary', headers: AUTH })).json(),
    )
    expect(after.skills.enabledCount).toBe(before.skills.enabledCount + 1)
    expect(after.skills.estTokens).toBe(before.skills.estTokens + 500)
    expect(after.totalEstTokens).toBe(before.totalEstTokens + 500)
    // per-source counts include the whole catalog (k rows included).
    expect(after.perSource['claude-user'].skills).toBeGreaterThanOrEqual(1)
    expect(after.perSource.k.mcpServers).toBe(4)
  })
})

describe('GET /api/capabilities/hooks + readCapabilityHooks', () => {
  it("the route carries K's synthesizer-mounted hooks labeled sourceKind 'k'", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities/hooks', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = CatalogHooksResponseSchema.parse(res.json())
    const kHooks = body.hooks.filter(h => h.sourceKind === 'k')
    expect(kHooks.length).toBeGreaterThan(0)
    expect(kHooks[0].commandSummary).toContain('mounted by the synthesizer')
  })

  it('flattens host user hooks + plugin hooks from a fixture home; malformed input warns, never throws', () => {
    const home = tmpDir('k-cap-hooks-')
    fs.writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo host-hook' }] }] },
      }),
      'utf8',
    )
    const install = path.join(home, 'plugins', 'cache', 'mkt', 'hooky', '1.0.0')
    fs.mkdirSync(path.join(install, 'hooks'), { recursive: true })
    fs.writeFileSync(
      path.join(install, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin-hook' }] }] } }),
      'utf8',
    )
    fs.writeFileSync(
      path.join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'hooky@mkt': [{ installPath: install, version: '1.0.0' }] } }),
      'utf8',
    )

    const { hooks, warnings } = readCapabilityHooks({ claudeHome: home })
    expect(warnings).toEqual([])
    const user = hooks.find(h => h.sourceKind === 'claude-user')!
    expect(user).toMatchObject({ event: 'PostToolUse', matcher: 'Bash', commandSummary: 'echo host-hook' })
    const plugin = hooks.find(h => h.sourceKind === 'claude-plugin')!
    expect(plugin).toMatchObject({ event: 'Stop', matcher: null, pluginName: 'hooky', commandSummary: 'echo plugin-hook' })

    // Malformed settings.json → warning, no throw.
    fs.writeFileSync(path.join(home, 'settings.json'), '{ not json', 'utf8')
    const degraded = readCapabilityHooks({ claudeHome: home })
    expect(degraded.warnings.some(w => w.message.includes('unparseable'))).toBe(true)
  })
})

describe('POST /api/capabilities/rescan', () => {
  it('returns the RescanResult and broadcasts WS capabilities_update', async () => {
    const broadcasts: WsMessage[] = []
    const unsub = eventBus.onBroadcast(m => broadcasts.push(m))
    try {
      const res = await app.inject({ method: 'POST', url: '/api/capabilities/rescan', headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(RescanResultSchema.parse(res.json())).toEqual(CANNED_RESCAN)
      expect(broadcasts).toContainEqual({ type: 'capabilities_update', scannedAt: CANNED_RESCAN.scannedAt })
    } finally {
      unsub()
    }
  })
})

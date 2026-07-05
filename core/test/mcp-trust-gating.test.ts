/**
 * D-070 MCP trust gating — the full trust lifecycle over the /api/capabilities
 * routes (Lane A wave A4).
 *
 * Locks:
 *   - discovery lands DEFAULT-DISABLED + untrusted; enabling an untrusted server
 *     is a 400 (enable requires trust);
 *   - POST trust pins trusted_hash = config_hash (+ optional enable-in-one);
 *   - config drift at rescan auto-disables + clears trust → enabling again 400s
 *     until re-trusted (the route surface reflects applyHostDiscovery);
 *   - probe: refused 400 for untrusted OR disabled servers (probing SPAWNS the
 *     server); a REAL probe against a fixture MCP server records est_tokens +
 *     toolCount; a failing probe → 502 {error}, probe_status='failed', and the
 *     server STAYS enabled (failure never disables);
 *   - env VALUES appear in NO payload of the whole lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { CatalogMcpServerSchema } from '@k/shared'
import { db } from '../src/db.js'
import { canonicalMcpConfigHash, applyHostDiscovery, type DiscoveredMcpServer } from '../src/host-discovery.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROBE_FIXTURE = path.join(__dirname, 'fixtures', 'probe-mcp-server.mjs')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const seededKeys: string[] = []

/** Build a DiscoveredMcpServer item (the applyHostDiscovery input shape). */
function discovered(name: string, command: string, args: string[], env: Record<string, string> = {}): DiscoveredMcpServer {
  return {
    qualifiedKey: `user:${name}`,
    name,
    sourceKind: 'claude-user',
    projectId: null,
    command,
    args,
    env,
    configHash: canonicalMcpConfigHash(command, args, env),
  }
}

/** Ingest one server through the REAL sync path (so defaults are the real ones). */
function ingest(item: DiscoveredMcpServer): string {
  applyHostDiscovery([], [item], [])
  seededKeys.push(item.qualifiedKey)
  return item.qualifiedKey
}

const mcpUrl = (key: string, tail = ''): string => `/api/capabilities/mcp/${encodeURIComponent(key)}${tail}`

const rowOf = (key: string): Record<string, unknown> =>
  db.prepare(`SELECT * FROM host_mcp_servers WHERE qualified_key = ?`).get(key) as Record<string, unknown>

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  try {
    for (const key of seededKeys) {
      db.prepare(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`).run(key)
      db.prepare(`DELETE FROM app_config WHERE key = ?`).run(`capabilities.probe.${key}`)
    }
  } catch { /* ignore */ }
  await app.close()
})

describe('trust lifecycle', () => {
  it('lands default-disabled + untrusted; enable-before-trust is a 400; trust → enable works', async () => {
    const key = ingest(discovered(`life-${uuid().slice(0, 8)}`, 'node', ['x.js']))

    // Born disabled + untrusted (the real sync default).
    expect(rowOf(key)).toMatchObject({ enabled: 0, trusted_hash: null })

    // Enable requires trust (D-070).
    const premature = await app.inject({ method: 'PATCH', url: mcpUrl(key), headers: AUTH, payload: { enabled: true } })
    expect(premature.statusCode).toBe(400)
    expect((premature.json() as { error: string }).error).toMatch(/not trusted/)
    expect(rowOf(key).enabled).toBe(0) // unchanged

    // Trust pins the hash; the response is the UPDATED CatalogMcpServer.
    const trust = await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: {} })
    expect(trust.statusCode).toBe(200)
    expect(CatalogMcpServerSchema.parse(trust.json())).toMatchObject({ id: key, trusted: true, enabled: false })
    expect(rowOf(key).trusted_hash).toBe(rowOf(key).config_hash)

    // Now enabling succeeds.
    const enable = await app.inject({ method: 'PATCH', url: mcpUrl(key), headers: AUTH, payload: { enabled: true } })
    expect(enable.statusCode).toBe(200)
    expect(CatalogMcpServerSchema.parse(enable.json())).toMatchObject({ id: key, trusted: true, enabled: true })
  })

  it('trust {enable:true} pins and enables in one call', async () => {
    const key = ingest(discovered(`one-${uuid().slice(0, 8)}`, 'node', ['y.js']))
    const res = await app.inject({
      method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true },
    })
    expect(res.statusCode).toBe(200)
    expect(CatalogMcpServerSchema.parse(res.json())).toMatchObject({ trusted: true, enabled: true })
  })

  it('config drift at rescan auto-disables + clears trust; re-enable 400s until re-trusted', async () => {
    const name = `drift-${uuid().slice(0, 8)}`
    const key = ingest(discovered(name, 'node', ['v1.js']))
    await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true } })
    expect(rowOf(key)).toMatchObject({ enabled: 1 })

    // The host config changes; the next rescan (applied through the REAL sync
    // path) must auto-disable + clear the pin.
    applyHostDiscovery([], [discovered(name, 'node', ['v2-CHANGED.js'])], [])
    expect(rowOf(key)).toMatchObject({ enabled: 0, trusted_hash: null })

    const reenable = await app.inject({ method: 'PATCH', url: mcpUrl(key), headers: AUTH, payload: { enabled: true } })
    expect(reenable.statusCode).toBe(400)
    expect((reenable.json() as { error: string }).error).toMatch(/not trusted/)
  })
})

describe('probe gating + execution', () => {
  it('refuses to probe an untrusted or disabled server (400 — probing spawns it)', async () => {
    const untrusted = ingest(discovered(`pu-${uuid().slice(0, 8)}`, 'node', ['z.js']))
    const refused = await app.inject({ method: 'POST', url: mcpUrl(untrusted, '/probe'), headers: AUTH })
    expect(refused.statusCode).toBe(400)
    expect((refused.json() as { error: string }).error).toMatch(/trusted AND enabled/)

    const trustedOnly = ingest(discovered(`pd-${uuid().slice(0, 8)}`, 'node', ['z.js']))
    await app.inject({ method: 'POST', url: mcpUrl(trustedOnly, '/trust'), headers: AUTH, payload: {} })
    const stillRefused = await app.inject({ method: 'POST', url: mcpUrl(trustedOnly, '/probe'), headers: AUTH })
    expect(stillRefused.statusCode).toBe(400)
  })

  it('REAL probe: spawns the fixture MCP server, records est_tokens + toolCount, returns the updated row', async () => {
    const key = ingest(discovered(`live-${uuid().slice(0, 8)}`, process.execPath, [PROBE_FIXTURE]))
    await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true } })

    const res = await app.inject({ method: 'POST', url: mcpUrl(key, '/probe'), headers: AUTH })
    expect(res.statusCode).toBe(200)
    const server = CatalogMcpServerSchema.parse(res.json())
    expect(server.estTokens).toBeGreaterThan(0)
    expect(server.toolCount).toBe(2) // the fixture registers exactly two tools
    expect(rowOf(key).probe_status).toBe('ok')

    // The projection stays consistent on a later GET.
    const list = await app.inject({ method: 'GET', url: '/api/capabilities/mcp', headers: AUTH })
    const listed = (list.json() as { servers: Array<{ id: string; estTokens: number | null; toolCount: number | null }> })
      .servers.find(s => s.id === key)!
    expect(listed.estTokens).toBe(server.estTokens)
    expect(listed.toolCount).toBe(2)
  }, 30_000)

  it('config drift INVALIDATES probed metadata: estTokens/toolCount never describe the old config (M-1)', async () => {
    const name = `stale-${uuid().slice(0, 8)}`
    const key = ingest(discovered(name, process.execPath, [PROBE_FIXTURE]))
    await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true } })
    const probed = await app.inject({ method: 'POST', url: mcpUrl(key, '/probe'), headers: AUTH })
    expect(probed.statusCode).toBe(200)
    expect((probed.json() as { estTokens: number | null }).estTokens).toBeGreaterThan(0)

    // The host config drifts → rescan revokes trust AND the stale probe figures.
    applyHostDiscovery([], [discovered(name, process.execPath, ['-e', 'CHANGED'])], [])
    expect(rowOf(key)).toMatchObject({ est_tokens: null, probe_status: null, enabled: 0, trusted_hash: null })

    const list = await app.inject({ method: 'GET', url: '/api/capabilities/mcp', headers: AUTH })
    const listed = (list.json() as { servers: Array<{ id: string; estTokens: number | null; toolCount: number | null }> })
      .servers.find(s => s.id === key)!
    expect(listed.estTokens).toBeNull()
    expect(listed.toolCount).toBeNull() // sidecar hash no longer matches — never surfaced
  }, 30_000)

  it('a FAILING probe → 502 {error}, probe_status=failed, server STAYS enabled', async () => {
    const key = ingest(discovered(`fail-${uuid().slice(0, 8)}`, process.execPath, ['-e', 'process.exit(1)']))
    await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true } })

    const res = await app.inject({ method: 'POST', url: mcpUrl(key, '/probe'), headers: AUTH })
    expect(res.statusCode).toBe(502)
    expect((res.json() as { error: string }).error).toMatch(/probe failed/)
    expect(rowOf(key)).toMatchObject({ probe_status: 'failed', enabled: 1 }) // failure never disables
  }, 30_000)
})

describe('env-value hygiene across the lifecycle', () => {
  it('no payload in the whole trust/enable/list flow ever carries an env VALUE', async () => {
    const secret = `sekret-${uuid().slice(0, 8)}-value`
    const key = ingest(discovered(`env-${uuid().slice(0, 8)}`, 'node', ['e.js'], { API_TOKEN: secret }))

    const trust = await app.inject({ method: 'POST', url: mcpUrl(key, '/trust'), headers: AUTH, payload: { enable: true } })
    const patch = await app.inject({ method: 'PATCH', url: mcpUrl(key), headers: AUTH, payload: { enabled: false } })
    const list = await app.inject({ method: 'GET', url: '/api/capabilities/mcp', headers: AUTH })
    const summary = await app.inject({ method: 'GET', url: '/api/capabilities/summary', headers: AUTH })

    for (const res of [trust, patch, list, summary]) {
      expect(res.body).not.toContain(secret)
    }
    expect(list.body).toContain('API_TOKEN') // the NAME is trust-surface information
  })
})

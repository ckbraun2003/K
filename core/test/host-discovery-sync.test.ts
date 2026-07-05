/**
 * host-discovery.ts SYNC (Lane A wave A1) — the transactional catalog upsert.
 *
 * Locks (D-069/D-070):
 *   - everything discovered lands DEFAULT-DISABLED (enabled=0) with full
 *     provenance columns + qualified_key;
 *   - rescan NEVER touches the K-scoped enabled overlay (metadata refresh under
 *     an enabled row keeps enabled=1);
 *   - vanished assets flip status='missing' — but are DELETED when disabled AND
 *     unreferenced by any profile; a referenced-missing row is KEPT;
 *   - MCP config drift vs a pinned trusted_hash → auto-disable + trust cleared +
 *     warning (an UNtrusted config change is just a metadata update);
 *   - the whole apply is ONE transaction: a mid-apply failure rolls EVERYTHING
 *     back including the persisted last-rescan result;
 *   - k-native (source_kind='k') rows are invisible to the sync (never flagged);
 *   - project-scoped host_mcp_servers rows are FK'd to projects — deleteProject
 *     cleans them (the work_items NO-ACTION-FK pattern).
 *
 * Uses the shared singleton db (vitest K_DATA_DIR); every fixture key is
 * uuid-suffixed so reruns/parallel files never collide.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, configDb } from '../src/db.js'
import { registerSkill } from '../src/skills.js'
import {
  syncHostDiscovery,
  applyHostDiscovery,
  readLastRescanResult,
  canonicalMcpConfigHash,
  type DiscoveredSkill,
} from '../src/host-discovery.js'

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** A fixture claudeHome with an empty claude.json path (no MCP side effects). */
function fixtureHome(): { home: string; claudeJsonPath: string } {
  const home = tmpDir('k-hds-home-')
  return { home, claudeJsonPath: path.join(home, '.claude.json') } // file absent → silent
}

function writeUserSkill(home: string, name: string, body: string): string {
  const dir = path.join(home, 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8')
  return dir
}

/** Run a sync scoped to the fixture (explicit projects=[], fixed platform). */
function sync(home: string, claudeJsonPath: string, projects: Array<{ id: string; localPath: string }> = []) {
  return syncHostDiscovery({ claudeHome: home, claudeJsonPath, projects, platform: process.platform })
}

const skillRow = (key: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM skills WHERE qualified_key = ?`).get(key) as Record<string, unknown> | undefined
const mcpRow = (key: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM host_mcp_servers WHERE qualified_key = ?`).get(key) as Record<string, unknown> | undefined

// ─── skills: insert defaults + overlay preservation ───────────────────────────

describe('syncHostDiscovery — skills', () => {
  it('inserts discovered skills DEFAULT-DISABLED with full provenance', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const name = `fresh-${uuid().slice(0, 8)}`
    const dir = writeUserSkill(home, name, `---\nname: ${name}\ndescription: freshly found\n---\nbody`)

    const result = sync(home, claudeJsonPath)
    expect(result.skills.discovered).toBeGreaterThanOrEqual(1)

    const row = skillRow(`user:${name}`)
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      name,
      description: 'freshly found',
      type: 'skill',
      triggerType: 'manual',
      enabled: 0, // ← default-disabled, always
      source_kind: 'claude-user',
      origin_path: dir,
      source: dir,
      status: 'ok',
      qualified_key: `user:${name}`,
    })
    expect(row!.content_hash).toBeTruthy()
    expect(Number(row!.est_tokens)).toBeGreaterThan(0)
    expect(Number(row!.est_tokens_meta)).toBeGreaterThan(0)
    expect(Number(row!.last_scanned_at)).toBeGreaterThan(0)
  })

  it('rescan refreshes metadata but NEVER touches the enabled overlay', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const name = `overlay-${uuid().slice(0, 8)}`
    writeUserSkill(home, name, 'version one')
    sync(home, claudeJsonPath)

    // Operator enables via the K-scoped overlay:
    db.prepare(`UPDATE skills SET enabled = 1 WHERE qualified_key = ?`).run(`user:${name}`)
    const before = skillRow(`user:${name}`)!

    // Host content changes; rescan:
    writeUserSkill(home, name, 'version two — changed')
    const result = sync(home, claudeJsonPath)

    const after = skillRow(`user:${name}`)!
    expect(after.enabled).toBe(1) // overlay preserved
    expect(after.content_hash).not.toBe(before.content_hash)
    expect(after.id).toBe(before.id) // upsert, not replace
    expect(result.skills.updated).toBeGreaterThanOrEqual(1)
    expect(result.skills.discovered).toBe(0)
  })

  it('an unchanged re-seen row refreshes last_scanned_at without counting as updated', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const name = `same-${uuid().slice(0, 8)}`
    writeUserSkill(home, name, 'immutable content')
    sync(home, claudeJsonPath)
    const result = sync(home, claudeJsonPath)
    expect(result.skills.updated).toBe(0)
    expect(result.skills.discovered).toBe(0)
  })

  it('vanished + enabled → status missing (row KEPT); vanished + disabled + unreferenced → DELETED', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const kept = `kept-${uuid().slice(0, 8)}`
    const gone = `gone-${uuid().slice(0, 8)}`
    writeUserSkill(home, kept, 'kept body')
    writeUserSkill(home, gone, 'gone body')
    sync(home, claudeJsonPath)
    db.prepare(`UPDATE skills SET enabled = 1 WHERE qualified_key = ?`).run(`user:${kept}`)

    // Remove BOTH from the host and rescan:
    fs.rmSync(path.join(home, 'skills', kept), { recursive: true, force: true })
    fs.rmSync(path.join(home, 'skills', gone), { recursive: true, force: true })
    const result = sync(home, claudeJsonPath)

    expect(skillRow(`user:${kept}`)).toMatchObject({ status: 'missing', enabled: 1 })
    expect(skillRow(`user:${gone}`)).toBeUndefined()
    expect(result.skills.missing).toBeGreaterThanOrEqual(2)
  })

  it('a PROFILE-referenced missing row is KEPT even when disabled', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const name = `refd-${uuid().slice(0, 8)}`
    writeUserSkill(home, name, 'referenced body')
    sync(home, claudeJsonPath)

    // A profile references the qualified key in its skills[]. Tier is irrelevant to
    // the reference check — SECRETARY keeps this fixture row out of the lead roster
    // that w8a-org-pipeline.test.ts asserts on (shared test db).
    db.prepare(
      `INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
       VALUES (?, ?, 'secretary', 'secretary', '', '[]', '[]', ?, ?)`,
    ).run(`prof-${uuid().slice(0, 8)}`, `prof-${uuid().slice(0, 8)}`, JSON.stringify([`user:${name}`]), Date.now())

    fs.rmSync(path.join(home, 'skills', name), { recursive: true, force: true })
    sync(home, claudeJsonPath)

    expect(skillRow(`user:${name}`)).toMatchObject({ status: 'missing', enabled: 0 })
  })

  it('a missing row that REAPPEARS flips back to ok and counts as updated', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const name = `back-${uuid().slice(0, 8)}`
    writeUserSkill(home, name, 'here')
    sync(home, claudeJsonPath)
    db.prepare(`UPDATE skills SET enabled = 1 WHERE qualified_key = ?`).run(`user:${name}`)
    fs.rmSync(path.join(home, 'skills', name), { recursive: true, force: true })
    sync(home, claudeJsonPath)
    expect(skillRow(`user:${name}`)!.status).toBe('missing')

    writeUserSkill(home, name, 'here')
    const result = sync(home, claudeJsonPath)
    expect(skillRow(`user:${name}`)).toMatchObject({ status: 'ok', enabled: 1 })
    expect(result.skills.updated).toBeGreaterThanOrEqual(1)
  })

  it('k-native rows are INVISIBLE to the sync — never flagged missing', () => {
    const name = `knative-${uuid().slice(0, 8)}`
    registerSkill({ name, type: 'skill', source: 'inline prompt', triggerType: 'manual' })
    const { home, claudeJsonPath } = fixtureHome()
    sync(home, claudeJsonPath) // scans an empty host

    expect(skillRow(name)).toMatchObject({ status: 'ok', source_kind: 'k', enabled: 1 })
  })
})

// ─── MCP: trust gating + drift ────────────────────────────────────────────────

function writeClaudeJson(home: string, json: unknown): string {
  const file = path.join(home, '.claude.json')
  fs.writeFileSync(file, JSON.stringify(json), 'utf8')
  return file
}

describe('syncHostDiscovery — host MCP servers', () => {
  it('inserts discovered servers default-disabled + untrusted', () => {
    const { home } = fixtureHome()
    const name = `srv-${uuid().slice(0, 8)}`
    const file = writeClaudeJson(home, {
      mcpServers: { [name]: { command: 'node', args: ['s.js'], env: { KEY: 'v1' } } },
    })
    const result = sync(home, file)
    expect(result.mcpServers.discovered).toBeGreaterThanOrEqual(1)

    const row = mcpRow(`user:${name}`)!
    expect(row).toMatchObject({
      name,
      source_kind: 'claude-user',
      enabled: 0,
      trusted_hash: null,
      trusted_at: null,
      est_tokens: null,
      probe_status: null,
      status: 'ok',
      command: 'node',
    })
    expect(row.config_hash).toBe(canonicalMcpConfigHash('node', ['s.js'], { KEY: 'v1' }))
    expect(JSON.parse(String(row.env))).toEqual({ KEY: 'v1' })
  })

  it('config drift vs a PINNED trust → auto-disable + trust cleared + warning', () => {
    const { home } = fixtureHome()
    const name = `drift-${uuid().slice(0, 8)}`
    const key = `user:${name}`
    let file = writeClaudeJson(home, {
      mcpServers: { [name]: { command: 'node', args: ['s.js'], env: { KEY: 'v1' } } },
    })
    sync(home, file)

    // Operator reviews + trusts + enables:
    db.prepare(`UPDATE host_mcp_servers SET trusted_hash = config_hash, trusted_at = ?, enabled = 1 WHERE qualified_key = ?`)
      .run(Date.now(), key)

    // Host config changes underneath the pin:
    file = writeClaudeJson(home, {
      mcpServers: { [name]: { command: 'node', args: ['s.js'], env: { KEY: 'CHANGED' } } },
    })
    const result = sync(home, file)

    const row = mcpRow(key)!
    expect(row).toMatchObject({ enabled: 0, trusted_hash: null, trusted_at: null, status: 'ok' })
    expect(row.config_hash).toBe(canonicalMcpConfigHash('node', ['s.js'], { KEY: 'CHANGED' }))
    expect(result.warnings.some(w => w.message.includes(`"${key}" config changed since it was trusted`))).toBe(true)
    expect(result.mcpServers.updated).toBeGreaterThanOrEqual(1)
  })

  it('an UNTRUSTED config change is a plain metadata update — no trust consequences', () => {
    const { home } = fixtureHome()
    const name = `untrusted-${uuid().slice(0, 8)}`
    let file = writeClaudeJson(home, { mcpServers: { [name]: { command: 'node', args: ['a.js'] } } })
    sync(home, file)
    file = writeClaudeJson(home, { mcpServers: { [name]: { command: 'node', args: ['b.js'] } } })
    const result = sync(home, file)

    const row = mcpRow(`user:${name}`)!
    expect(row).toMatchObject({ enabled: 0, trusted_hash: null })
    expect(result.warnings.some(w => w.message.includes('config changed since it was trusted'))).toBe(false)
    expect(result.mcpServers.updated).toBeGreaterThanOrEqual(1)
  })

  it('vanished servers: disabled+unreferenced deleted; enabled kept as missing', () => {
    const { home } = fixtureHome()
    const keep = `mkeep-${uuid().slice(0, 8)}`
    const drop = `mdrop-${uuid().slice(0, 8)}`
    let file = writeClaudeJson(home, {
      mcpServers: {
        [keep]: { command: 'node', args: [] },
        [drop]: { command: 'node', args: [] },
      },
    })
    sync(home, file)
    db.prepare(`UPDATE host_mcp_servers SET enabled = 1, trusted_hash = config_hash WHERE qualified_key = ?`)
      .run(`user:${keep}`)

    file = writeClaudeJson(home, { mcpServers: {} })
    sync(home, file)

    expect(mcpRow(`user:${keep}`)).toMatchObject({ status: 'missing', enabled: 1 })
    expect(mcpRow(`user:${drop}`)).toBeUndefined()
  })

  it('project-scoped servers satisfy the projects FK, and deleteProject cleans them', () => {
    const projDir = tmpDir('k-hds-proj-')
    const projectId = `hds-proj-${uuid().slice(0, 8)}`
    projectsDb.insertProject.run({
      id: projectId,
      name: projectId,
      localPath: projDir,
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    const srvName = `psrv-${uuid().slice(0, 8)}`
    fs.writeFileSync(
      path.join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { [srvName]: { command: 'node', args: [] } } }),
      'utf8',
    )
    const { home } = fixtureHome()
    sync(home, path.join(home, '.claude.json'), [{ id: projectId, localPath: projDir }])

    const key = `project:${projectId}:${srvName}`
    expect(mcpRow(key)).toMatchObject({ source_kind: 'claude-project', project_id: projectId, enabled: 0 })

    // FK safety: deleting the project must clean its discovered servers, not throw.
    expect(() => projectsDb.deleteProject(projectId)).not.toThrow()
    expect(mcpRow(key)).toBeUndefined()
  })
})

// ─── atomicity + persistence ──────────────────────────────────────────────────

const fakeSkill = (key: string): DiscoveredSkill => ({
  qualifiedKey: key,
  name: key,
  description: '',
  sourceKind: 'claude-user',
  originPath: path.join(os.tmpdir(), 'k-hds-fake', key),
  projectId: null,
  pluginId: null,
  pluginVersion: null,
  contentHash: 'deadbeef',
  estTokens: 1,
  estTokensMeta: 1,
})

describe('applyHostDiscovery — atomicity + last-rescan persistence', () => {
  it('persists the RescanResult; readLastRescanResult round-trips it', () => {
    const { home, claudeJsonPath } = fixtureHome()
    const result = sync(home, claudeJsonPath)
    expect(readLastRescanResult()).toEqual(result)
  })

  it('a mid-apply failure rolls back the WHOLE rescan (rows AND the persisted result)', () => {
    const before = configDb.get('capabilities.lastRescan')
    const good = `atomic-a-${uuid().slice(0, 8)}`
    const bad = `atomic-b-${uuid().slice(0, 8)}`

    // The second item violates skills.name NOT NULL (the scanners can never produce
    // this — feeding the apply step directly bypasses them) AFTER the first item's
    // INSERT has already run inside the transaction.
    const poisoned = { ...fakeSkill(`user:${bad}`), name: null as unknown as string }
    expect(() => applyHostDiscovery([fakeSkill(`user:${good}`), poisoned], [], [])).toThrow()

    // Rollback: the GOOD row (inserted before the violation) must be gone too, and
    // the persisted last-rescan must be untouched.
    expect(skillRow(`user:${good}`)).toBeUndefined()
    expect(skillRow(`user:${bad}`)).toBeUndefined()
    expect(configDb.get('capabilities.lastRescan')).toBe(before)
  })

  it('a garbled persisted result degrades to null, never a throw', () => {
    const before = configDb.get('capabilities.lastRescan')
    configDb.set('capabilities.lastRescan', '{ not json')
    expect(readLastRescanResult()).toBeNull()
    if (before !== undefined) configDb.set('capabilities.lastRescan', before)
  })
})

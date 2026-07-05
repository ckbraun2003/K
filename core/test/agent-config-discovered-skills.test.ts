/**
 * synthesizeConfigDir + resolveRunAssets — DISCOVERED SKILLS (Lane A wave A3).
 *
 * End-to-end through the real synthesizer with fixture claudeHomes + catalog db
 * rows. Locks (D-069):
 *   - a granted enabled+ok discovered skill is VENDOR-COPIED into the run config
 *     (host content never read live by the run) under the collision-safe mount
 *     dir `<name>--<sourceKind>`; k-native skills mount exactly as before;
 *   - k-native WINS the bare mount name; two same-name discovered skills get the
 *     short key-hash suffix;
 *   - a vanished/unconfined origin THROWS (fail-closed) — no partial config;
 *   - a symlinked file inside a discovered skill is SKIPPED (copyDirConfined);
 *   - a > byte-cap discovered skill THROWS;
 *   - claude-project skills scoped to a DIFFERENT project are silently DROPPED
 *     from the mounts (run still synthesizes); the matching project mounts;
 *   - a DISABLED discovered grant throws GrantError at synth (fail-closed).
 *
 * Fixture idioms mirror run-assets-shim.test.ts (hand-built profiles, temp
 * dataDirs, ANTHROPIC_API_KEY pinned so synthesis never copies host credentials).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import { synthesizeConfigDir, COPY_CONFINED_MAX_BYTES, type SynthesizeOpts } from '../src/agent-config.js'
import { GrantError } from '../src/authority.js'
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
afterAll(() => {
  for (const key of seededKeys) db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(key)
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

function profileWith(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'a3-skills-test',
    name: 'a3-skills-test',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...overrides,
  }
}

/** Write a host skill dir + register its catalog row; returns the qualified key. */
function seedHostSkill(opts: {
  home?: string
  projectDir?: string
  projectId?: string
  name: string
  content?: string
  enabled?: 0 | 1
  origin?: string // override origin_path (missing-origin tests)
}): string {
  const name = opts.name
  const isProject = opts.projectDir !== undefined
  const originDefault = isProject
    ? path.join(opts.projectDir!, '.claude', 'skills', name)
    : path.join(opts.home!, 'skills', name)
  const origin = opts.origin ?? originDefault
  if (!opts.origin) {
    fs.mkdirSync(originDefault, { recursive: true })
    fs.writeFileSync(path.join(originDefault, 'SKILL.md'), opts.content ?? `---\nname: ${name}\n---\nbody of ${name}`, 'utf8')
  }
  const key = isProject ? `project:${opts.projectId}:${name}` : `user:${name}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, project_id, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, '', 'skill', ?, 'manual', ?, ?, ?, ?, ?, 'h', 10, 5, 'ok', ?, ?)`,
  ).run(
    uuid(), name, origin, opts.enabled ?? 1, Date.now(),
    isProject ? 'claude-project' : 'claude-user', origin, opts.projectId ?? null, Date.now(), key,
  )
  seededKeys.push(key)
  return key
}

function synth(profile: AgentProfile, opts: Partial<SynthesizeOpts> & { claudeHome?: string } = {}) {
  const dataDir = tmpDir('k-a3-data-')
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const cfg = synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR, ...opts })
  return { cfg, dataDir, runId }
}

describe('discovered skills — vendoring + collision rule', () => {
  it('vendor-copies an enabled discovered skill under <name>--<sourceKind>; k-native mounts unchanged', () => {
    const home = tmpDir('k-a3-home-')
    const name = `vend-${uuid().slice(0, 8)}`
    const key = seedHostSkill({ home, name, content: `---\nname: ${name}\n---\nHOST BODY` })

    const { cfg } = synth(profileWith({ skills: ['search-first', key] }), { claudeHome: home })
    const skillsDir = path.join(cfg.configDir, 'skills')
    // k-native keeps its bare mount:
    expect(fs.existsSync(path.join(skillsDir, 'search-first', 'SKILL.md'))).toBe(true)
    // discovered vendored under the provenance-suffixed mount:
    const vendored = path.join(skillsDir, `${name}--claude-user`, 'SKILL.md')
    expect(fs.readFileSync(vendored, 'utf8')).toBe(`---\nname: ${name}\n---\nHOST BODY`)
  })

  it('k-native WINS the bare name; the discovered same-name skill mounts suffixed', () => {
    const home = tmpDir('k-a3-home-')
    // A host skill named exactly like a k-native bundle skill:
    const key = seedHostSkill({ home, name: 'search-first', content: 'host impostor' })

    const { cfg } = synth(profileWith({ skills: ['search-first', key] }), { claudeHome: home })
    const skillsDir = path.join(cfg.configDir, 'skills')
    // The bare mount is K's own library copy, NOT the host content:
    expect(fs.readFileSync(path.join(skillsDir, 'search-first', 'SKILL.md'), 'utf8')).not.toBe('host impostor')
    expect(fs.readFileSync(path.join(skillsDir, 'search-first--claude-user', 'SKILL.md'), 'utf8')).toBe('host impostor')
  })

  it('two same-name PLUGIN skills collide on <name>--claude-plugin: the second gets a short key-hash suffix', () => {
    const home = tmpDir('k-a3-home-')
    const name = `dup-${uuid().slice(0, 8)}`
    const seedPluginSkill = (plugin: string, content: string): string => {
      const dir = path.join(home, 'plugins', 'cache', 'mkt', plugin, '1.0.0', 'skills', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
      const key = `plugin:${plugin}@mkt:${name}`
      db.prepare(
        `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                             source_kind, origin_path, plugin_id, content_hash, est_tokens, est_tokens_meta,
                             status, last_scanned_at, qualified_key)
         VALUES (?, ?, '', 'skill', ?, 'manual', 1, ?, 'claude-plugin', ?, ?, 'h', 10, 5, 'ok', ?, ?)`,
      ).run(uuid(), name, dir, Date.now(), dir, `${plugin}@mkt`, Date.now(), key)
      seededKeys.push(key)
      return key
    }
    const keyA = seedPluginSkill('plug-a', 'from A')
    const keyB = seedPluginSkill('plug-b', 'from B')

    const { cfg } = synth(profileWith({ skills: [keyA, keyB] }), { claudeHome: home })
    const skillsDir = path.join(cfg.configDir, 'skills')
    const mounts = fs.readdirSync(skillsDir).filter(d => d.startsWith(`${name}--claude-plugin`))
    expect(mounts).toHaveLength(2)
    expect(mounts).toContain(`${name}--claude-plugin`) // first wins the base suffix form
    const suffixed = mounts.find(m => m !== `${name}--claude-plugin`)!
    expect(suffixed).toMatch(new RegExp(`^${name}--claude-plugin--[0-9a-f]{8}$`)) // deterministic key hash
    // Both vendored copies carry their own origin's content:
    const bodies = mounts.map(m => fs.readFileSync(path.join(skillsDir, m, 'SKILL.md'), 'utf8')).sort()
    expect(bodies).toEqual(['from A', 'from B'])
  })

  it('a user-scope and a project-scope skill sharing a name mount side by side (distinct sourceKind suffixes)', () => {
    const home = tmpDir('k-a3-home-')
    const proj = tmpDir('k-a3-proj-')
    const name = `pair-${uuid().slice(0, 8)}`
    const userKey = seedHostSkill({ home, name, content: 'user copy' })
    const projKey = seedHostSkill({ projectDir: proj, projectId: 'a3pc', name, content: 'project copy' })

    const { cfg } = synth(profileWith({ skills: [userKey, projKey] }), {
      claudeHome: home,
      projectId: 'a3pc',
      projects: [{ id: 'a3pc', localPath: proj }],
    })
    const skillsDir = path.join(cfg.configDir, 'skills')
    expect(fs.readFileSync(path.join(skillsDir, `${name}--claude-user`, 'SKILL.md'), 'utf8')).toBe('user copy')
    expect(fs.readFileSync(path.join(skillsDir, `${name}--claude-project`, 'SKILL.md'), 'utf8')).toBe('project copy')
  })
})

describe('discovered skills — fail-closed guards', () => {
  it('a vanished origin dir THROWS (no partial config)', () => {
    const home = tmpDir('k-a3-home-')
    const name = `gone-${uuid().slice(0, 8)}`
    const key = seedHostSkill({ home, name, origin: path.join(home, 'skills', name) }) // origin never created

    expect(() => synth(profileWith({ skills: [key] }), { claudeHome: home })).toThrow(
      /missing or escapes the allowlisted skill roots/,
    )
  })

  it('an origin OUTSIDE every allowlisted root THROWS', () => {
    const home = tmpDir('k-a3-home-')
    const outside = tmpDir('k-a3-outside-')
    const name = `esc-${uuid().slice(0, 8)}`
    const originDir = path.join(outside, name)
    fs.mkdirSync(originDir, { recursive: true })
    fs.writeFileSync(path.join(originDir, 'SKILL.md'), 'outside', 'utf8')
    const key = seedHostSkill({ home, name, origin: originDir })

    expect(() => synth(profileWith({ skills: [key] }), { claudeHome: home })).toThrow(
      /missing or escapes the allowlisted skill roots/,
    )
  })

  it('a DISABLED discovered grant throws GrantError at synth', () => {
    const home = tmpDir('k-a3-home-')
    const key = seedHostSkill({ home, name: `dis-${uuid().slice(0, 8)}`, enabled: 0 })
    expect(() => synth(profileWith({ skills: [key] }), { claudeHome: home })).toThrow(GrantError)
    expect(() => synth(profileWith({ skills: [key] }), { claudeHome: home })).toThrow(/is disabled/)
  })

  it('a symlinked file inside a discovered skill is SKIPPED, not vendored', () => {
    const home = tmpDir('k-a3-home-')
    const outside = tmpDir('k-a3-outside-')
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'SECRET', 'utf8')
    const name = `sym-${uuid().slice(0, 8)}`
    const key = seedHostSkill({ home, name })
    try {
      fs.symlinkSync(secret, path.join(home, 'skills', name, 'link.md'))
    } catch {
      return // symlinks unavailable (Windows without dev-mode) — skip
    }

    const { cfg } = synth(profileWith({ skills: [key] }), { claudeHome: home })
    const mount = path.join(cfg.configDir, 'skills', `${name}--claude-user`)
    expect(fs.existsSync(path.join(mount, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(mount, 'link.md'))).toBe(false)
  })

  it('a discovered skill past the byte cap THROWS (fail-closed vendoring)', () => {
    const home = tmpDir('k-a3-home-')
    const name = `fat-${uuid().slice(0, 8)}`
    const key = seedHostSkill({ home, name })
    fs.writeFileSync(path.join(home, 'skills', name, 'blob.bin'), Buffer.alloc(COPY_CONFINED_MAX_BYTES + 1))

    expect(() => synth(profileWith({ skills: [key] }), { claudeHome: home })).toThrow(/exceeds \d+ bytes/)
  })
})

describe('discovered skills — project-scope filter (F-068 precedent)', () => {
  it('an other-project skill is silently DROPPED; the matching project mounts', () => {
    const proj = tmpDir('k-a3-proj-')
    const name = `scope-${uuid().slice(0, 8)}`
    const key = seedHostSkill({ projectDir: proj, projectId: 'a3scope', name, content: 'scoped body' })
    const projects = [{ id: 'a3scope', localPath: proj }]

    // Run targeting a DIFFERENT project: dropped, run still synthesizes.
    const other = synth(profileWith({ skills: [key] }), { projectId: 'someone-else', projects })
    expect(fs.existsSync(path.join(other.cfg.configDir, 'skills', `${name}--claude-project`))).toBe(false)

    // Run targeting THE project: mounted.
    const match = synth(profileWith({ skills: [key] }), { projectId: 'a3scope', projects })
    expect(
      fs.readFileSync(path.join(match.cfg.configDir, 'skills', `${name}--claude-project`, 'SKILL.md'), 'utf8'),
    ).toBe('scoped body')
  })
})

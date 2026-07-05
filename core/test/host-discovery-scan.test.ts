/**
 * host-discovery.ts SCANNERS (Lane A wave A1) — pure fixture-driven coverage of
 * the four host scanners. No db writes here (sync coverage lives in
 * host-discovery-sync.test.ts).
 *
 * Locks:
 *   - user skills: depth ≤ 2 (first level, one nested group level, never deeper),
 *     lstat discipline (symlinked SKILL.md / symlinked skill dir skipped w/ warning),
 *     tolerant frontmatter (malformed → dirname + ''), unsafe-name skip, duplicate-
 *     key first-wins, missing skills dir → empty WITHOUT warning;
 *   - project skills: per-registered-project roots, missing dir silent;
 *   - plugin skills: installed_plugins.json v2 is AUTHORITATIVE (installPath
 *     realpath-verified under the cache — a poisoned index pointing outside disk
 *     is refused w/ warning), version 'unknown' tolerated, version≠2 → guarded
 *     glob fallback that skips temp_git_* junk;
 *   - host MCP: user + project scopes, .mcp.json vs ~/.claude.json precedence
 *     (claude.json project entry wins), win32 case-variant project keys dedup
 *     last-write-wins w/ warning, non-stdio skipped w/ warning, canonical
 *     config hash is env-key-order independent.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import {
  parseSkillFrontmatter,
  canonicalMcpConfigHash,
  scanUserSkills,
  scanProjectSkills,
  scanPluginSkills,
  scanHostMcpServers,
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

/** Write <root>/<...segments>/SKILL.md with the given content. */
function writeSkill(root: string, segments: string[], content: string): string {
  const dir = path.join(root, ...segments)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  return dir
}

const FM = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`

// ─── parseSkillFrontmatter ────────────────────────────────────────────────────

describe('parseSkillFrontmatter', () => {
  it('reads single-line name/description and unwraps quotes', () => {
    expect(parseSkillFrontmatter(`---\nname: alpha\ndescription: "does things"\n---\nbody`)).toEqual({
      name: 'alpha',
      description: 'does things',
    })
    expect(parseSkillFrontmatter(`---\r\nname: 'q'\r\ndescription: d\r\n---\r\nbody`)).toEqual({
      name: 'q',
      description: 'd',
    })
  })

  it('is tolerant: no fence, unclosed fence, or fence past the 8KB cap → {}', () => {
    expect(parseSkillFrontmatter('no frontmatter at all')).toEqual({})
    expect(parseSkillFrontmatter('---\nname: never-closed\n')).toEqual({})
    expect(parseSkillFrontmatter(`---\n${'x'.repeat(9 * 1024)}\nname: late\n---\n`)).toEqual({})
  })
})

// ─── canonicalMcpConfigHash ───────────────────────────────────────────────────

describe('canonicalMcpConfigHash', () => {
  it('is env-key-order independent and value-sensitive', () => {
    const a = canonicalMcpConfigHash('node', ['x.js'], { B: '2', A: '1' })
    const b = canonicalMcpConfigHash('node', ['x.js'], { A: '1', B: '2' })
    const c = canonicalMcpConfigHash('node', ['x.js'], { A: '1', B: 'CHANGED' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

// ─── scanUserSkills ───────────────────────────────────────────────────────────

describe('scanUserSkills', () => {
  it('discovers first-level skills with frontmatter metadata, hash, and token estimates', () => {
    const home = tmpDir('k-hd-user-')
    const content = FM('Alpha Skill', 'does alpha things')
    const dir = writeSkill(home, ['skills', 'alpha'], content)

    const { items, warnings } = scanUserSkills(home)
    expect(warnings).toEqual([])
    expect(items).toHaveLength(1)
    const s = items[0]
    expect(s.qualifiedKey).toBe('user:alpha') // key = DIR name, not frontmatter name
    expect(s.name).toBe('Alpha Skill')
    expect(s.description).toBe('does alpha things')
    expect(s.sourceKind).toBe('claude-user')
    expect(s.originPath).toBe(dir)
    expect(s.projectId).toBeNull()
    expect(s.pluginId).toBeNull()
    expect(s.contentHash).toBe(createHash('sha256').update(content).digest('hex'))
    expect(s.estTokens).toBeGreaterThan(0)
    expect(s.estTokensMeta).toBeGreaterThan(0)
  })

  it('defaults name=dirname, description="" for absent AND malformed frontmatter', () => {
    const home = tmpDir('k-hd-user-')
    writeSkill(home, ['skills', 'plain'], 'just a body, no fence\n')
    writeSkill(home, ['skills', 'broken'], '---\nname: never closed\n') // unclosed fence

    const { items } = scanUserSkills(home)
    const byKey = new Map(items.map(s => [s.qualifiedKey, s]))
    expect(byKey.get('user:plain')).toMatchObject({ name: 'plain', description: '' })
    expect(byKey.get('user:broken')).toMatchObject({ name: 'broken', description: '' })
  })

  it('recurses ONE extra level for skill groups; depth stays ≤ 2', () => {
    const home = tmpDir('k-hd-user-')
    writeSkill(home, ['skills', 'group', 'a'], FM('a', 'nested a'))
    writeSkill(home, ['skills', 'group', 'b'], FM('b', 'nested b'))
    // depth 3 — must NOT be discovered
    writeSkill(home, ['skills', 'group', 'sub', 'too-deep'], FM('too-deep', 'nope'))

    const { items } = scanUserSkills(home)
    const keys = items.map(s => s.qualifiedKey).sort()
    expect(keys).toEqual(['user:a', 'user:b'])
  })

  it('a dir WITH a SKILL.md is terminal — its children are never scanned', () => {
    const home = tmpDir('k-hd-user-')
    writeSkill(home, ['skills', 'top'], FM('top', 'top-level'))
    writeSkill(home, ['skills', 'top', 'child'], FM('child', 'hidden below a real skill'))

    const { items } = scanUserSkills(home)
    expect(items.map(s => s.qualifiedKey)).toEqual(['user:top'])
  })

  it('skips a dir whose name cannot form a safe qualified key, with a warning', () => {
    const home = tmpDir('k-hd-user-')
    writeSkill(home, ['skills', 'bad name'], FM('bad', 'has a space'))
    writeSkill(home, ['skills', 'good'], FM('good', 'fine'))

    const { items, warnings } = scanUserSkills(home)
    expect(items.map(s => s.qualifiedKey)).toEqual(['user:good'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('unusable as a catalog key')
  })

  it('duplicate keys within one scan: first discovery wins, warning for the rest', () => {
    const home = tmpDir('k-hd-user-')
    // 'group/x' (nested) and 'x' (first-level) both key as user:x
    writeSkill(home, ['skills', 'group', 'x'], FM('x', 'nested'))
    writeSkill(home, ['skills', 'x'], FM('x', 'first-level'))

    const { items, warnings } = scanUserSkills(home)
    expect(items.filter(s => s.qualifiedKey === 'user:x')).toHaveLength(1)
    expect(warnings.some(w => w.message.includes('duplicate skill key "user:x"'))).toBe(true)
  })

  it('missing skills dir → empty result, NO warning', () => {
    const home = tmpDir('k-hd-user-') // no skills/ inside
    expect(scanUserSkills(home)).toEqual({ items: [], warnings: [] })
  })

  it('a SYMLINKED SKILL.md is skipped with a warning (lstat, never followed)', () => {
    const home = tmpDir('k-hd-user-')
    const outside = tmpDir('k-hd-outside-')
    const target = path.join(outside, 'SKILL.md')
    fs.writeFileSync(target, FM('evil', 'outside content'), 'utf8')
    const dir = path.join(home, 'skills', 'linked')
    fs.mkdirSync(dir, { recursive: true })
    try {
      fs.symlinkSync(target, path.join(dir, 'SKILL.md'))
    } catch {
      return // Windows without dev-mode: symlink creation EPERMs — skip (w8b-f069 pattern)
    }
    const { items, warnings } = scanUserSkills(home)
    expect(items).toEqual([])
    expect(warnings.some(w => w.message.includes('symlinked SKILL.md skipped'))).toBe(true)
  })

  it('a SYMLINKED skill DIRECTORY is skipped with a warning (junction-safe)', () => {
    const home = tmpDir('k-hd-user-')
    const outside = tmpDir('k-hd-outside-')
    writeSkill(outside, ['real-skill'], FM('real-skill', 'lives outside the root'))
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    try {
      // 'junction' works without privileges on Windows; type is ignored on POSIX.
      fs.symlinkSync(path.join(outside, 'real-skill'), path.join(home, 'skills', 'real-skill'), 'junction')
    } catch {
      return
    }
    const { items, warnings } = scanUserSkills(home)
    expect(items).toEqual([])
    expect(warnings.some(w => w.message.includes('symlinked skill directory skipped'))).toBe(true)
  })
})

// ─── scanProjectSkills ────────────────────────────────────────────────────────

describe('scanProjectSkills', () => {
  it('scans <localPath>/.claude/skills per registered project; missing dir is silent', () => {
    const projA = tmpDir('k-hd-proj-')
    const projB = tmpDir('k-hd-proj-') // no .claude/skills at all
    const dir = writeSkill(projA, ['.claude', 'skills', 'deploy'], FM('deploy', 'ships it'))

    const { items, warnings } = scanProjectSkills([
      { id: 'proj-a', localPath: projA },
      { id: 'proj-b', localPath: projB },
    ])
    expect(warnings).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      qualifiedKey: 'project:proj-a:deploy',
      sourceKind: 'claude-project',
      projectId: 'proj-a',
      originPath: dir,
    })
  })
})

// ─── scanPluginSkills ─────────────────────────────────────────────────────────

/** Build a claudeHome with a plugins/cache and an installed_plugins.json index. */
function pluginHome(index: unknown): string {
  const home = tmpDir('k-hd-plug-')
  fs.mkdirSync(path.join(home, 'plugins', 'cache'), { recursive: true })
  if (index !== undefined) {
    fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify(index), 'utf8')
  }
  return home
}

describe('scanPluginSkills', () => {
  it('discovers skills via the v2 index (version "unknown" tolerated)', () => {
    const home = pluginHome(undefined)
    const install = path.join(home, 'plugins', 'cache', 'official', 'toolbelt', 'unknown')
    writeSkill(install, ['skills', 'lint'], FM('lint', 'lints things'))
    fs.writeFileSync(
      path.join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'toolbelt@official': [{ installPath: install, version: 'unknown' }] } }),
      'utf8',
    )

    const { items, warnings } = scanPluginSkills(home)
    expect(warnings).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      qualifiedKey: 'plugin:toolbelt@official:lint',
      sourceKind: 'claude-plugin',
      pluginId: 'toolbelt@official',
      pluginVersion: 'unknown',
    })
  })

  it('REFUSES an installPath that realpath-resolves outside the cache (poisoned index)', () => {
    const home = pluginHome(undefined)
    const outside = tmpDir('k-hd-poison-')
    writeSkill(outside, ['skills', 'exfil'], FM('exfil', 'should never be discovered'))
    fs.writeFileSync(
      path.join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'evil@mkt': [{ installPath: outside, version: '1.0.0' }] } }),
      'utf8',
    )

    const { items, warnings } = scanPluginSkills(home)
    expect(items).toEqual([])
    expect(warnings.some(w => w.message.includes('OUTSIDE the plugin cache'))).toBe(true)
  })

  it('warns (not throws) for an installPath that does not resolve on disk', () => {
    const home = pluginHome({
      version: 2,
      plugins: { 'ghost@mkt': [{ installPath: path.join(os.tmpdir(), 'k-hd-nonexistent-xyz'), version: '1.0.0' }] },
    })
    const { items, warnings } = scanPluginSkills(home)
    expect(items).toEqual([])
    expect(warnings.some(w => w.message.includes('does not resolve on disk'))).toBe(true)
  })

  it('version ≠ 2 → guarded glob fallback that skips temp_git_* junk', () => {
    const home = pluginHome({ version: 3, plugins: {} })
    writeSkill(path.join(home, 'plugins', 'cache', 'mkt', 'plug', '1.0.0'), ['skills', 'fmt'], FM('fmt', 'formats'))
    // temp clone junk that a blind glob would pick up:
    writeSkill(path.join(home, 'plugins', 'cache', 'temp_git_123', 'x', 'y'), ['skills', 'junk'], FM('junk', 'no'))
    writeSkill(path.join(home, 'plugins', 'cache', 'mkt', 'temp_git_456', 'z'), ['skills', 'junk2'], FM('junk2', 'no'))

    const { items, warnings } = scanPluginSkills(home)
    expect(items.map(s => s.qualifiedKey)).toEqual(['plugin:plug@mkt:fmt'])
    expect(items[0].pluginVersion).toBe('1.0.0')
    expect(warnings.some(w => w.message.includes('unsupported installed_plugins.json version'))).toBe(true)
  })

  it('no installed_plugins.json at all → empty, no warnings', () => {
    const home = pluginHome(undefined)
    expect(scanPluginSkills(home)).toEqual({ items: [], warnings: [] })
  })
})

// ─── scanHostMcpServers ───────────────────────────────────────────────────────

function writeClaudeJson(json: unknown): string {
  const dir = tmpDir('k-hd-mcp-')
  const file = path.join(dir, '.claude.json')
  fs.writeFileSync(file, JSON.stringify(json), 'utf8')
  return file
}

describe('scanHostMcpServers', () => {
  it('discovers user-scope stdio servers with env captured and a canonical hash', () => {
    const file = writeClaudeJson({
      mcpServers: { serena: { command: 'uvx', args: ['serena'], env: { MODE: 'ide' } } },
    })
    const { items, warnings } = scanHostMcpServers(file, [])
    expect(warnings).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      qualifiedKey: 'user:serena',
      name: 'serena',
      sourceKind: 'claude-user',
      projectId: null,
      command: 'uvx',
      args: ['serena'],
      env: { MODE: 'ide' },
    })
    expect(items[0].configHash).toBe(canonicalMcpConfigHash('uvx', ['serena'], { MODE: 'ide' }))
  })

  it('skips non-stdio (sse/http/url-typed) servers with a warning — v1 scope', () => {
    const file = writeClaudeJson({
      mcpServers: {
        remote1: { type: 'sse', url: 'https://x.example/sse' },
        remote2: { type: 'http', url: 'https://x.example/mcp' },
        urlish: { url: 'https://x.example/other' },
        local: { command: 'node', args: ['ok.js'] },
      },
    })
    const { items, warnings } = scanHostMcpServers(file, [])
    expect(items.map(s => s.qualifiedKey)).toEqual(['user:local'])
    expect(warnings.filter(w => w.message.includes('not stdio'))).toHaveLength(3)
  })

  it('matches ~/.claude.json project scopes to REGISTERED projects; case-variant keys dedup last-write-wins with a warning (win32)', () => {
    const projDir = tmpDir('k-hd-mcpproj-')
    const upper = projDir.toUpperCase()
    const lower = projDir.toLowerCase()
    const file = writeClaudeJson({
      projects: {
        [upper]: { mcpServers: { db: { command: 'first', args: [] } } },
        [lower]: { mcpServers: { db: { command: 'second', args: [] } } },
        [path.join(os.tmpdir(), 'unregistered-project')]: {
          mcpServers: { rogue: { command: 'never', args: [] } },
        },
      },
    })
    const { items, warnings } = scanHostMcpServers(file, [{ id: 'proj-1', localPath: projDir }], {
      platform: 'win32',
    })
    // the unregistered project's server never appears; the case-variant pair deduped
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ qualifiedKey: 'project:proj-1:db', command: 'second', projectId: 'proj-1' })
    expect(warnings.some(w => w.message.includes('duplicate MCP server definition "project:proj-1:db"'))).toBe(true)
  })

  it('reads <localPath>/.mcp.json; a ~/.claude.json project entry for the same server WINS (local scope precedence)', () => {
    const projDir = tmpDir('k-hd-mcpproj-')
    fs.writeFileSync(
      path.join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'from-mcp-json', args: [] }, only: { command: 'solo', args: [] } } }),
      'utf8',
    )
    const file = writeClaudeJson({
      projects: { [projDir]: { mcpServers: { shared: { command: 'from-claude-json', args: [] } } } },
    })
    const { items, warnings } = scanHostMcpServers(file, [{ id: 'p2', localPath: projDir }])
    const byKey = new Map(items.map(s => [s.qualifiedKey, s]))
    expect(byKey.get('project:p2:shared')?.command).toBe('from-claude-json')
    expect(byKey.get('project:p2:only')?.command).toBe('solo')
    expect(warnings.some(w => w.message.includes('last write wins'))).toBe(true)
  })

  it('malformed server entries (no command / bad args) are skipped with warnings, never a throw', () => {
    const file = writeClaudeJson({
      mcpServers: {
        nocmd: { args: [] },
        badargs: { command: 'node', args: [1, 2] },
        ok: { command: 'node' }, // args/env optional
      },
    })
    const { items, warnings } = scanHostMcpServers(file, [])
    expect(items.map(s => s.qualifiedKey)).toEqual(['user:ok'])
    expect(items[0]).toMatchObject({ args: [], env: {} })
    expect(warnings).toHaveLength(2)
  })

  it('missing ~/.claude.json → empty, no warnings; unparseable → warning', () => {
    const missing = path.join(tmpDir('k-hd-mcp-'), 'nope.json')
    expect(scanHostMcpServers(missing, [])).toEqual({ items: [], warnings: [] })

    const dir = tmpDir('k-hd-mcp-')
    const bad = path.join(dir, '.claude.json')
    fs.writeFileSync(bad, '{ not json', 'utf8')
    const { items, warnings } = scanHostMcpServers(bad, [])
    expect(items).toEqual([])
    expect(warnings.some(w => w.message.includes('unparseable JSON'))).toBe(true)
  })
})

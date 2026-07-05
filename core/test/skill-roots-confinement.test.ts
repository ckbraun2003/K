/**
 * skill-roots.ts — allowlisted-roots confinement + the D-069 qualified-key grammar
 * (host-integration Wave 0).
 *
 * confineToRoots is the ONLY approval gate a discovered path passes before any
 * read/vendor, so this suite proves BOTH gates per root class:
 *   gate 1 — string-level isPathWithin (rejects absolute-elsewhere, `..` escape,
 *            and normalizes mixed-separator Windows paths);
 *   gate 2 — realpath containment (a symlink planted IN-root pointing OUTSIDE is
 *            refused; uses the Windows-EPERM-safe symlink pattern from
 *            w8b-f069-skill-dispatch.test.ts).
 * Plus root-set closure: a project deregistered (removed from projectRoots) stops
 * confining, fail-closed.
 *
 * assertSafeSkillKey: the full grammar matrix — all four valid forms parse; '..',
 * ':' abuse, empty segments, and '@' outside the plugin segment are rejected with
 * the typed SkillKeyError.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveSkillRoots,
  confineToRoots,
  assertSafeSkillKey,
  SkillKeyError,
  type SkillRoots,
} from '../src/skill-roots.js'

let base: string
let roots: SkillRoots
let kSkillFile: string
let userSkillFile: string
let pluginSkillFile: string
let projectSkillFile: string
let outsideFile: string

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-skill-roots-'))
  const assetsDir = path.join(base, 'agent-config')
  const claudeHome = path.join(base, 'claude-home')
  const projectSkillsRoot = path.join(base, 'proj1', '.claude', 'skills')

  kSkillFile = path.join(assetsDir, 'skills', 'alpha', 'SKILL.md')
  userSkillFile = path.join(claudeHome, 'skills', 'beta', 'SKILL.md')
  pluginSkillFile = path.join(claudeHome, 'plugins', 'cache', 'mp', 'plug', 'skills', 'gamma', 'SKILL.md')
  projectSkillFile = path.join(projectSkillsRoot, 'delta', 'SKILL.md')
  outsideFile = path.join(base, 'outside', 'secret.md')

  for (const f of [kSkillFile, userSkillFile, pluginSkillFile, projectSkillFile, outsideFile]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, `# ${path.basename(path.dirname(f))}\n`, 'utf8')
  }

  roots = resolveSkillRoots({
    assetsDir,
    claudeHome,
    projectRoots: new Map([['proj-1', projectSkillsRoot]]),
  })
})

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('resolveSkillRoots — root derivation', () => {
  it('derives the four root classes from the injectable claudeHome/assetsDir', () => {
    expect(roots.kAssets).toBe(path.join(base, 'agent-config', 'skills'))
    expect(roots.claudeUser).toBe(path.join(base, 'claude-home', 'skills'))
    expect(roots.pluginCache).toBe(path.join(base, 'claude-home', 'plugins', 'cache'))
    expect(roots.projectRoots.get('proj-1')).toBe(path.join(base, 'proj1', '.claude', 'skills'))
  })

  it('defaults claudeHome under the OS home dir and projectRoots to empty', () => {
    const def = resolveSkillRoots()
    expect(def.claudeUser).toBe(path.join(os.homedir(), '.claude', 'skills'))
    expect(def.pluginCache).toBe(path.join(os.homedir(), '.claude', 'plugins', 'cache'))
    expect(def.projectRoots.size).toBe(0)
  })
})

describe('confineToRoots — accepts in-root paths per root class', () => {
  it('accepts a file under the K assets root', () => {
    const hit = confineToRoots(kSkillFile, roots)
    expect(hit).not.toBeNull()
    expect(hit!.root).toBe(roots.kAssets)
    expect(fs.readFileSync(hit!.real, 'utf8')).toContain('alpha')
  })

  it('accepts a file under the claude-user root', () => {
    const hit = confineToRoots(userSkillFile, roots)
    expect(hit).not.toBeNull()
    expect(hit!.root).toBe(roots.claudeUser)
  })

  it('accepts a file under the plugin-cache root', () => {
    const hit = confineToRoots(pluginSkillFile, roots)
    expect(hit).not.toBeNull()
    expect(hit!.root).toBe(roots.pluginCache)
  })

  it('accepts a file under a registered project root', () => {
    const hit = confineToRoots(projectSkillFile, roots)
    expect(hit).not.toBeNull()
    expect(hit!.root).toBe(roots.projectRoots.get('proj-1'))
  })
})

describe('confineToRoots — rejections (fail-closed)', () => {
  it('rejects an absolute path outside every root', () => {
    expect(confineToRoots(outsideFile, roots)).toBeNull()
  })

  it('rejects a relative path outright', () => {
    expect(confineToRoots(path.join('agent-config', 'skills', 'alpha', 'SKILL.md'), roots)).toBeNull()
  })

  it('rejects a `..` escape whose string starts inside a root', () => {
    // RAW string concat (not path.join, which would collapse the '..' before the
    // guard ever saw it) — the string literally starts with the root prefix.
    const escape = roots.kAssets + path.sep + '..' + path.sep + '..' + path.sep + 'outside' + path.sep + 'secret.md'
    expect(escape.startsWith(roots.kAssets)).toBe(true)
    expect(fs.existsSync(escape)).toBe(true) // the target exists — only confinement refuses it
    expect(confineToRoots(escape, roots)).toBeNull()
  })

  it('rejects the root itself (a skill path is always UNDER a root)', () => {
    expect(confineToRoots(roots.kAssets, roots)).toBeNull()
  })

  it('rejects a nonexistent in-root path (realpath throws → null)', () => {
    expect(confineToRoots(path.join(roots.kAssets, 'ghost', 'SKILL.md'), roots)).toBeNull()
  })

  it.runIf(process.platform === 'win32')(
    'normalizes mixed-separator Windows paths: in-root accepted, escaping rejected',
    () => {
      // Forward slashes under a backslash root still confine (path.resolve normalizes).
      const mixedInRoot = roots.kAssets + '/alpha/SKILL.md'
      const hit = confineToRoots(mixedInRoot, roots)
      expect(hit).not.toBeNull()
      // A mixed-separator traversal that resolves OUTSIDE the root is refused.
      const mixedEscape = roots.kAssets + '/alpha\\..\\..\\..\\outside\\secret.md'
      expect(confineToRoots(mixedEscape, roots)).toBeNull()
    },
  )

  it('a symlink INSIDE a root pointing OUTSIDE is refused (gate 2, realpath)', () => {
    const linkPath = path.join(roots.claudeUser, 'evil-link.md')
    try {
      fs.symlinkSync(outsideFile, linkPath)
    } catch {
      // Windows may require privileges/dev-mode for symlink creation (EPERM). Skip
      // ONLY this realpath sub-assertion where symlinks are unavailable — the
      // string-gate cases above run everywhere (w8b-f069 pattern).
      return
    }
    try {
      // Sanity: gate 1 alone would PASS this (string path is in-root)…
      expect(path.resolve(linkPath).startsWith(path.resolve(roots.claudeUser) + path.sep)).toBe(true)
      // …so a null here is genuinely the realpath gate refusing the escape.
      expect(confineToRoots(linkPath, roots)).toBeNull()
    } finally {
      try { fs.rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    }
  })

  it('a project root removed from the map stops confining (deregistration closes the root)', () => {
    const withoutProject: SkillRoots = { ...roots, projectRoots: new Map() }
    expect(confineToRoots(projectSkillFile, withoutProject)).toBeNull()
    // The other roots are unaffected.
    expect(confineToRoots(kSkillFile, withoutProject)).not.toBeNull()
  })
})

describe('assertSafeSkillKey — the four valid forms', () => {
  it('bare k-native name', () => {
    expect(assertSafeSkillKey('search-first')).toEqual({ kind: 'k', name: 'search-first' })
  })

  it('user:<name> (dots/underscores allowed in qualified segments)', () => {
    expect(assertSafeSkillKey('user:my-skill.v2')).toEqual({ kind: 'claude-user', name: 'my-skill.v2' })
  })

  it('project:<projectId>:<name> (uuid-shaped project ids pass)', () => {
    expect(assertSafeSkillKey('project:5cf8a1b2-3c4d-5e6f-7a8b-9c0d1e2f3a4b:deploy')).toEqual({
      kind: 'claude-project',
      projectId: '5cf8a1b2-3c4d-5e6f-7a8b-9c0d1e2f3a4b',
      name: 'deploy',
    })
  })

  it('plugin:<plugin>@<marketplace>:<name>', () => {
    expect(assertSafeSkillKey('plugin:everything-claude-code@claude-plugins:tdd-workflow')).toEqual({
      kind: 'claude-plugin',
      pluginId: 'everything-claude-code@claude-plugins',
      name: 'tdd-workflow',
    })
  })
})

describe('assertSafeSkillKey — rejections (typed SkillKeyError)', () => {
  const bad = (key: string) => expect(() => assertSafeSkillKey(key)).toThrow(SkillKeyError)

  it('empty key / empty segments', () => {
    bad('')
    bad('user:')
    bad('project::deploy')
    bad('project:pid:')
    bad('plugin:@mp:name')
    bad('plugin:plug@:name')
    bad(':name')
  })

  it("'..' and '.' traversal in any segment", () => {
    bad('..')
    bad('user:..')
    bad('user:.')
    bad('user:a..b')
    bad('project:..:deploy')
    bad('project:pid:..')
    bad('plugin:a..b@mp:name')
    bad('plugin:plug@mp:..')
  })

  it("':' abuse — wrong segment counts and unknown prefixes", () => {
    bad('user:a:b')
    bad('project:pid')
    bad('project:pid:name:extra')
    bad('plugin:plug@mp')
    bad('plugin:plug@mp:name:extra')
    bad('foo:bar')
    bad('k:name') // no 'k:' prefix exists — k-native is the BARE form only
  })

  it("'@' outside the plugin segment", () => {
    bad('user:na@me')
    bad('project:p@id:name')
    bad('project:pid:na@me')
    bad('plugin:plug@mp:na@me')
    bad('plugin:a@b@c:name') // two '@'s — not <plugin>@<marketplace>
  })

  it('charset violations (spaces, slashes, path separators)', () => {
    bad('has space')
    bad('a/b')
    bad('a\\b')
    bad('user:a/b')
    bad('user:a b')
  })

  it('bare k-native keys use the STRICTER assertSafeSegment charset (no dots)', () => {
    bad('my.skill') // dots are qualified-segment-only; bare = /^[a-z0-9-]+$/i
    expect(assertSafeSkillKey('my-skill')).toEqual({ kind: 'k', name: 'my-skill' })
  })
})

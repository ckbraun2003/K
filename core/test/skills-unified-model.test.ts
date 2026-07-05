/**
 * skills.ts::readSkillSource — the unified k-native + discovered model (A2).
 *
 * Locks:
 *   - a DISCOVERED row (db row carries origin_path) reads <origin_path>/SKILL.md
 *     through confineToRoots (string gate + realpath gate per allowlisted root);
 *   - ANY failure — root not covering the path, planted symlink escaping the
 *     root, vanished file, empty content — degrades to the RAW `source` text
 *     (the origin path string), never a throw and never an unconfined read;
 *   - k-native rows and hand-built Skill objects (no db row) take the pre-D-069
 *     branch byte-identically (inline text verbatim; repo skills read + confined).
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'
import { readSkillSource, registerSkill, rowToSkill } from '../src/skills.js'
import { resolveSkillRoots } from '../src/skill-roots.js'

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const seededIds: string[] = []
afterAll(() => {
  for (const id of seededIds) db.prepare(`DELETE FROM skills WHERE id = ?`).run(id)
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** Insert a discovered row whose origin_path points at `originDir` and return its
 *  wire Skill shape (rowToSkill — exactly what the trigger/eval paths hand around). */
function seedDiscoveredRow(originDir: string) {
  const id = uuid()
  const name = `unified-${uuid().slice(0, 8)}`
  db.prepare(
    `INSERT INTO skills (id, name, description, type, source, triggerType, enabled, createdAt,
                         source_kind, origin_path, content_hash, est_tokens, est_tokens_meta,
                         status, last_scanned_at, qualified_key)
     VALUES (?, ?, '', 'skill', ?, 'manual', 0, ?, 'claude-user', ?, 'h', 1, 1, 'ok', ?, ?)`,
  ).run(id, name, originDir, Date.now(), originDir, Date.now(), `user:${name}`)
  seededIds.push(id)
  return rowToSkill(db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as Record<string, unknown>)
}

describe('readSkillSource — discovered rows', () => {
  it('reads <origin_path>/SKILL.md through the allowlisted roots', () => {
    const home = tmpDir('k-unified-home-')
    const originDir = path.join(home, 'skills', 'host-skill')
    fs.mkdirSync(originDir, { recursive: true })
    fs.writeFileSync(path.join(originDir, 'SKILL.md'), 'HOST SKILL CONTENT — do the thing.', 'utf8')

    const skill = seedDiscoveredRow(originDir)
    const roots = resolveSkillRoots({ claudeHome: home })
    expect(readSkillSource(skill, { roots })).toBe('HOST SKILL CONTENT — do the thing.')
  })

  it('degrades to the raw source text when the origin is OUTSIDE every root', () => {
    const elsewhere = tmpDir('k-unified-outside-')
    const originDir = path.join(elsewhere, 'rogue-skill')
    fs.mkdirSync(originDir, { recursive: true })
    fs.writeFileSync(path.join(originDir, 'SKILL.md'), 'MUST NEVER BE READ', 'utf8')

    const skill = seedDiscoveredRow(originDir)
    // Roots cover a DIFFERENT claudeHome — the origin path has no covering root.
    const roots = resolveSkillRoots({ claudeHome: tmpDir('k-unified-home-') })
    const out = readSkillSource(skill, { roots })
    expect(out).toBe(skill.source) // the raw origin-path string, not the file content
    expect(out).not.toContain('MUST NEVER BE READ')
  })

  it('degrades when the SKILL.md has vanished (status drift before rescan)', () => {
    const home = tmpDir('k-unified-home-')
    const originDir = path.join(home, 'skills', 'gone-skill')
    fs.mkdirSync(originDir, { recursive: true }) // dir exists, no SKILL.md
    const skill = seedDiscoveredRow(originDir)
    const roots = resolveSkillRoots({ claudeHome: home })
    expect(readSkillSource(skill, { roots })).toBe(skill.source)
  })

  it('a planted symlink whose target escapes the root is refused (realpath gate) → degrade', () => {
    const home = tmpDir('k-unified-home-')
    const outside = tmpDir('k-unified-outside-')
    const target = path.join(outside, 'SKILL.md')
    fs.writeFileSync(target, 'EXFILTRATED CONTENT', 'utf8')
    const originDir = path.join(home, 'skills', 'linked-skill')
    fs.mkdirSync(originDir, { recursive: true })
    try {
      fs.symlinkSync(target, path.join(originDir, 'SKILL.md'))
    } catch {
      return // symlink creation unavailable (Windows without dev-mode) — skip
    }
    const skill = seedDiscoveredRow(originDir)
    const roots = resolveSkillRoots({ claudeHome: home })
    const out = readSkillSource(skill, { roots })
    expect(out).toBe(skill.source)
    expect(out).not.toContain('EXFILTRATED CONTENT')
  })
})

describe('readSkillSource — k-native rows stay byte-identical', () => {
  it('an inline-source registered skill returns the text verbatim', () => {
    const skill = registerSkill({
      name: `unified-inline-${uuid().slice(0, 8)}`,
      type: 'skill',
      source: 'just an inline prompt',
      triggerType: 'manual',
    })
    seededIds.push(skill.id)
    expect(readSkillSource(skill)).toBe('just an inline prompt')
  })

  it('a repo-relative agent-config/skills path still reads the file contents (F-069)', () => {
    const skill = registerSkill({
      name: `unified-builtin-${uuid().slice(0, 8)}`,
      type: 'workflow',
      source: 'agent-config/skills/onboarding/SKILL.md',
      triggerType: 'manual',
    })
    seededIds.push(skill.id)
    const out = readSkillSource(skill)
    expect(out).not.toBe(skill.source) // read the contents, not the path
    expect(out.length).toBeGreaterThan(100)
  })

  it('a hand-built Skill with no db row takes the k-native branch (no throw)', () => {
    const skill = {
      id: 'no-such-row',
      name: 'ghost',
      type: 'skill' as const,
      source: 'raw text',
      triggerType: 'manual' as const,
      schedule: null,
      eventTrigger: null,
      enabled: true,
      createdAt: Date.now(),
    }
    expect(readSkillSource(skill)).toBe('raw text')
  })
})

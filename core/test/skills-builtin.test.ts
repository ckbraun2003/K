/**
 * Built-in skill registry tests (Wave 6).
 *
 * The authored `agent-config/skills/*` workflows are declared in BUILTIN_SKILLS and
 * seeded into the skills table at bootstrap so they appear/trigger from the
 * Skills tab. These tests assert:
 *   - `create-web-ui-artifact` is registered as a built-in.
 *   - Every built-in entry satisfies CreateSkillSchema AND the same trigger-type
 *     boundary rule POST /api/skills enforces (so seeding can't store an invalid
 *     skill that would be silently dropped).
 *   - Its SKILL.md exists and its frontmatter `name` matches the registry.
 *   - seedBuiltinSkills() inserts the create-web-ui-artifact row and is idempotent.
 *
 * DB is isolated via vitest.config.ts K_DATA_DIR. Supervisor is not touched.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { validate as cronValidate } from 'node-cron'
import { CreateSkillSchema } from '@k/shared'
import { BUILTIN_SKILLS, seedBuiltinSkills, listSkills } from '../src/skills.js'
import { db } from '../src/db.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Derive the cleanup list from the registry at module scope so the afterAll
// deletion always runs the full set regardless of which tests execute (a body-
// scoped list would no-op if the seeding test were filtered/skipped, leaking
// stale built-in rows into the shared vitest temp DB).
const builtinNames = BUILTIN_SKILLS.map(s => s.name)
afterAll(() => {
  for (const name of builtinNames) {
    try { db.prepare('DELETE FROM skills WHERE name = ?').run(name) } catch { /* ignore */ }
  }
})

describe('BUILTIN_SKILLS', () => {
  it('includes create-web-ui-artifact as a manual workflow', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'create-web-ui-artifact')
    expect(skill).toBeDefined()
    expect(skill!.type).toBe('workflow')
    expect(skill!.triggerType).toBe('manual')
    expect(skill!.source).toBe('agent-config/skills/create-web-ui-artifact/SKILL.md')
  })

  it('every entry passes CreateSkillSchema and the trigger-type boundary rule', () => {
    for (const skill of BUILTIN_SKILLS) {
      // Same schema the POST /api/skills route parses with.
      expect(CreateSkillSchema.safeParse(skill).success).toBe(true)
      // Same consistency check the route enforces after parsing.
      if (skill.triggerType === 'schedule') {
        expect(skill.schedule && cronValidate(skill.schedule)).toBeTruthy()
      }
      if (skill.triggerType === 'event') {
        expect(skill.eventTrigger).toBeTruthy()
      }
    }
  })

  it('each built-in has a SKILL.md whose frontmatter name matches the registry', () => {
    for (const skill of BUILTIN_SKILLS) {
      const md = fs.readFileSync(path.join(REPO_ROOT, skill.source), 'utf8')
      expect(md).toMatch(new RegExp(`^name:\\s*${skill.name}\\s*$`, 'm'))
    }
  })
})

describe('seedBuiltinSkills', () => {
  it('registers create-web-ui-artifact and is idempotent', () => {
    // First seed inserts any missing built-ins (at minimum, create-web-ui-artifact
    // if it isn't already present from a prior bootstrap in this DB).
    seedBuiltinSkills()
    const after = listSkills()
    expect(after.some(s => s.name === 'create-web-ui-artifact')).toBe(true)
    const countCwua = after.filter(s => s.name === 'create-web-ui-artifact').length
    expect(countCwua).toBe(1)

    // Second seed must not duplicate any built-in (matched by name).
    const created = seedBuiltinSkills()
    expect(created).toEqual([])
    expect(listSkills().filter(s => s.name === 'create-web-ui-artifact').length).toBe(1)
  })

  it('re-seeding preserves a user edit (disabled flag survives)', () => {
    // Ensure the row exists, then simulate a user disabling it.
    seedBuiltinSkills()
    db.prepare('UPDATE skills SET enabled = 0 WHERE name = ?').run('create-web-ui-artifact')
    expect(
      listSkills().find(s => s.name === 'create-web-ui-artifact')!.enabled,
    ).toBe(false)

    // Re-seeding is idempotent and MUST NOT clobber the user's edit.
    seedBuiltinSkills()
    expect(
      listSkills().find(s => s.name === 'create-web-ui-artifact')!.enabled,
    ).toBe(false)
  })
})

/**
 * Campaign S2 — Memory layer A: gated reflection (LOCK suite).
 *
 * The kstore lesson surface is PROPOSE-ONLY. An agent can `lesson_propose`
 * (lands 'pending') and `lesson_list`; there is NO tool, anywhere in the
 * registry, that accepts/rejects/reviews a lesson. Operator approval happens
 * out of band. These LOCK tests pin the half of the "state machine" that is
 * actually enforced in code:
 *   - a proposed lesson ALWAYS lands 'pending' (a run can never self-approve),
 *   - no approve/accept/reject/review tool is exposed,
 *   - an agent cannot smuggle a non-pending status through the propose args,
 *   - the per-call "ONE" wording is advisory: a run may propose many lessons,
 *   - the lesson text boundary (1..4000) is enforced at the zod edge.
 *
 * Findings: S2-001 (no self-approve / no approval surface), S2-002 (no per-run
 * cap), S2-003 (text boundary). See testing/findings/S2-memory-work-tracking.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { kStoreTools, type KStoreContext } from '../src/mcp/k-store.js'
import type { Lesson } from '@k/shared'

const PROJECT_ID = uuid()
const RUN = uuid()
const createdLessonIds: string[] = []

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}
const ctx: KStoreContext = { runId: RUN }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `s2-gated-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/s2-gated',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  runsDb.insertRun.run({
    id: RUN, prompt: 's2 gated fixture', cwd: '/tmp/s2-gated', worktree: null, status: 'running',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
})

afterAll(() => {
  for (const id of createdLessonIds) db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S2 gated reflection: the approval surface does not exist', () => {
  it('S2-001: no kstore tool can approve / accept / reject / review a lesson', () => {
    const mutators = kStoreTools.filter(t => /approv|accept|reject|review/i.test(t.name))
    expect(mutators.map(t => t.name)).toEqual([])
    // The only lesson tools are propose + list.
    const lessonTools = kStoreTools.filter(t => t.name.startsWith('lesson_')).map(t => t.name).sort()
    expect(lessonTools).toEqual(['lesson_list', 'lesson_propose'])
  })

  it('S2-001: a proposed lesson always lands pending — a run cannot self-approve', () => {
    const lesson = call('lesson_propose', { lesson: 'When X, prefer Y.' }, ctx) as Lesson
    createdLessonIds.push(lesson.id)
    expect(lesson.status).toBe('pending')
    expect(lesson.reviewedAt).toBeNull()
    expect(lesson.runId).toBe(RUN)

    // It is visible to its run, but only ever as 'pending'.
    const pending = call('lesson_list', { status: 'pending' }, ctx) as Lesson[]
    expect(pending.some(l => l.id === lesson.id)).toBe(true)
    const accepted = call('lesson_list', { status: 'accepted' }, ctx) as Lesson[]
    expect(accepted.some(l => l.id === lesson.id)).toBe(false)
  })

  it('S2-001: an agent cannot smuggle a non-pending status through the propose args', () => {
    // The propose input schema has no `status` field — zod strips the extra key,
    // so a hand-crafted "accepted" never reaches the row.
    const lesson = call(
      'lesson_propose',
      { lesson: 'sneaky', status: 'accepted', reviewedAt: 123 } as unknown,
      ctx,
    ) as Lesson
    createdLessonIds.push(lesson.id)
    expect(lesson.status).toBe('pending')
    expect(lesson.reviewedAt).toBeNull()
  })
})

describe('S2 gated reflection: per-run proposal volume + text boundary', () => {
  it('S2-002: "ONE" is per call — a run may propose many lessons, each independent + pending', () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const l = call('lesson_propose', { lesson: `lesson number ${i}` }, ctx) as Lesson
      ids.push(l.id)
      createdLessonIds.push(l.id)
      expect(l.status).toBe('pending')
    }
    const mine = call('lesson_list', {}, ctx) as Lesson[]
    // Every one of the freshly proposed lessons is present (no per-run cap).
    for (const id of ids) expect(mine.some(l => l.id === id)).toBe(true)
  })

  it('S2-003: lesson text boundary — empty rejected, >4000 rejected, 4000 accepted', () => {
    expect(() => call('lesson_propose', { lesson: '' }, ctx)).toThrow()
    expect(() => call('lesson_propose', { lesson: 'a'.repeat(4001) }, ctx)).toThrow()
    const ok = call('lesson_propose', { lesson: 'a'.repeat(4000) }, ctx) as Lesson
    createdLessonIds.push(ok.id)
    expect(ok.lesson.length).toBe(4000)
    expect(ok.status).toBe('pending')
  })
})

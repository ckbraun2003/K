/**
 * Campaign S1 — constraint behaviors (LOCK / characterization).
 *
 *  - UNIQUE collisions throw: projects.name, skills.name.
 *  - events insert is `INSERT OR IGNORE` on UNIQUE(run_id, seq): a duplicate
 *    (run_id, seq) is silently dropped (changes=0) and the first row is kept —
 *    a stray duplicate seq in the live stream never aborts the run.
 *  - OR IGNORE does NOT suppress FOREIGN KEY violations: inserting an event for a
 *    non-existent run still throws (both via eventsDb.insertEvent and emitEvent).
 *  - ON CONFLICT upserts replace cleanly by PK: artifacts(slug),
 *    github_cache(project_id,kind), app_config(key).
 *
 * Findings: S1-004 (unique collisions), S1-005 (OR IGNORE dup-seq drop),
 * S1-006 (OR IGNORE does not mask FK), S1-007 (upsert-by-PK).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import {
  db, runsDb, eventsDb, projectsDb, skillsDb, artifactsDb, githubDb,
} from '../src/db.js'
import { eventBus } from '../src/events.js'

const projectIds: string[] = []
const skillIds: string[] = []
const runIds: string[] = []
const slugs: string[] = []

function mkProject(name: string): string {
  const id = uuid()
  projectsDb.insertProject.run({
    id, name, localPath: '/tmp/' + id, githubRemote: null,
    workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  projectIds.push(id)
  return id
}

function mkRun(): string {
  const id = uuid()
  runsDb.insertRun.run({
    id, prompt: 'p', cwd: '/tmp', worktree: null, status: 'queued', provider: 'claude',
    model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now(),
  })
  runIds.push(id)
  return id
}

function eventRow(runId: string, seq: number, text: string) {
  return {
    id: uuid(), runId, seq, type: 'status', ts: Date.now(), raw: null, text,
    tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
    toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
    subagentType: null, childLabel: null, contextTokens: null,
  }
}

afterAll(() => {
  for (const id of runIds) {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
  for (const id of skillIds) db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  for (const id of projectIds) {
    db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
  for (const s of slugs) db.prepare('DELETE FROM artifacts WHERE slug = ?').run(s)
})

describe('S1 — UNIQUE constraint collisions throw', () => {
  it('projects.name UNIQUE rejects a duplicate name', () => {
    const name = 'dup-project-' + uuid()
    mkProject(name)
    expect(() => mkProject(name)).toThrow(/UNIQUE/i)
  })

  it('skills.name UNIQUE rejects a duplicate name', () => {
    const name = 'dup-skill-' + uuid()
    const insert = (id: string) => {
      skillsDb.insertSkill.run({
        id, name, description: null, type: 'skill', source: 'echo hi',
        triggerType: 'manual', schedule: null, eventTrigger: null, enabled: 1, createdAt: Date.now(),
      })
      skillIds.push(id)
    }
    insert(uuid())
    expect(() => insert(uuid())).toThrow(/UNIQUE/i)
  })
})

describe('S1 — events INSERT OR IGNORE on UNIQUE(run_id, seq)', () => {
  it('a duplicate (run_id, seq) is silently dropped, keeping the first row', () => {
    const run = mkRun()
    const r1 = eventsDb.insertEvent.run(eventRow(run, 7, 'first'))
    const r2 = eventsDb.insertEvent.run(eventRow(run, 7, 'second'))
    expect(r1.changes).toBe(1)
    expect(r2.changes).toBe(0) // silently ignored — no throw into the stream handler
    const rows = eventsDb.listEvents.all(run) as Array<{ seq: number; text: string }>
    const atSeq7 = rows.filter(r => r.seq === 7)
    expect(atSeq7).toHaveLength(1)
    expect(atSeq7[0].text).toBe('first')
  })
})

describe('S1 — OR IGNORE does not mask FOREIGN KEY violations', () => {
  it('eventsDb.insertEvent for a non-existent run throws FK (not silently ignored)', () => {
    expect(() => eventsDb.insertEvent.run(eventRow(uuid(), 1, 'orphan'))).toThrow(/FOREIGN KEY/i)
  })

  it('eventBus.emitEvent for a non-existent run throws FK', () => {
    expect(() =>
      eventBus.emitEvent({ id: uuid(), runId: uuid(), seq: 1, type: 'status', ts: Date.now() } as never),
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('S1 — ON CONFLICT upserts replace cleanly by primary key', () => {
  it('artifacts(slug) upsert updates in place rather than throwing', () => {
    const slug = 'art-' + uuid()
    slugs.push(slug)
    const base = {
      slug, title: 't1', phase: null, status: null, tags: '[]',
      linkedRunId: null, updatedAt: 1, md: 'one', htmlPath: null,
    }
    artifactsDb.upsertArtifact.run(base)
    artifactsDb.upsertArtifact.run({ ...base, title: 't2', md: 'two', updatedAt: 2 })
    const row = artifactsDb.getArtifact.get(slug) as { title: string; md: string }
    expect(row.title).toBe('t2')
    expect(row.md).toBe('two')
  })

  it('github_cache(project_id, kind) upsert replaces the payload', () => {
    const projectId = mkProject('gh-' + uuid())
    githubDb.upsertGithubCache.run({ projectId, kind: 'ci', payload: '[1]', fetchedAt: 1 })
    githubDb.upsertGithubCache.run({ projectId, kind: 'ci', payload: '[1,2]', fetchedAt: 2 })
    const row = githubDb.getGithubCache.get(projectId, 'ci') as { payload: string; fetched_at: number }
    expect(row.payload).toBe('[1,2]')
    expect(row.fetched_at).toBe(2)
  })
})

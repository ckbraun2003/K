/**
 * Campaign S7 (LOCK / gating) — GitHub parse robustness, createPR argv injection
 * safety, and poller graceful degrade.
 *
 * EXTENDS github-parse.test.ts + create-pr.test.ts + github-poller.test.ts. Focus:
 *   - github-parse never throws on weird gh JSON (extra/partial/wrong-typed fields,
 *     non-array rollups, non-object rollup entries, float ids) and degrades to a
 *     sensible projection.
 *   - createPR builds a discrete argv array (no shell), passing every option value
 *     verbatim even when it contains shell metacharacters — exact binary, flag
 *     order, and NO --json / NO shell option.
 *   - pollOnce degrades gracefully when the fetch (gh) throws: no crash, cache
 *     untouched, no spurious broadcast, and the reentrancy guard is released so a
 *     later poll still works.
 *
 * `execa` is mocked (no live gh). Isolated K_DATA_DIR via vitest.config.ts.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { parsePrList, parseCiRuns, parseIssueList } from '../src/github-parse.js'

const mockExeca = vi.fn()
vi.mock('execa', () => ({ execa: mockExeca }))

// ── github-parse — never throws on adversarial gh JSON ─────────────────────────

describe('github-parse — adversarial inputs never throw', () => {
  const garbage: unknown[] = [
    null, undefined, 42, 'str', true, {}, { number: 'x' }, { number: 1, title: 2 },
    [[]], [null], [undefined], [42], ['s'], [{ number: 1 }], [{ title: 't' }],
  ]
  for (const fn of [parsePrList, parseCiRuns, parseIssueList]) {
    it(`${fn.name} returns an array and never throws across the garbage sweep`, () => {
      for (const g of garbage) {
        let out!: unknown
        expect(() => { out = fn(g as never) }).not.toThrow()
        expect(Array.isArray(out)).toBe(true)
      }
    })
  }
})

describe('parsePrList — partial / extra / hostile fields', () => {
  it('ignores unknown extra fields and defaults a missing state to OPEN', () => {
    const prs = parsePrList([
      { number: 3, title: 't', url: 'https://github.com/o/r/pull/3', extraJunk: { a: 1 }, danger: 'x'.repeat(5000) },
    ])
    expect(prs).toEqual([{ number: 3, title: 't', state: 'OPEN', url: 'https://github.com/o/r/pull/3', checks: 'none' }])
  })

  it('drops a non-http(s) url scheme at the ingest boundary (XSS-href defense)', () => {
    const prs = parsePrList([{ number: 1, title: 'evil', state: 'OPEN', url: 'javascript:alert(1)', statusCheckRollup: [] }])
    expect(prs[0].url).toBe('')
  })

  it('a non-array (but truthy) statusCheckRollup degrades to "none" (no throw)', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: { conclusion: 'FAILURE' } }])
    expect(prs[0].checks).toBe('none')
  })

  it('non-object rollup entries are treated as pending (their conclusion is undefined)', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: ['SUCCESS', 42, null] }])
    expect(prs[0].checks).toBe('pending')
  })
})

describe('parseCiRuns — partial / extra / hostile fields', () => {
  it('fills defaults for missing fields and normalizes empty-string conclusion to null', () => {
    expect(parseCiRuns([{ databaseId: 5, conclusion: '' }])).toEqual([
      { id: 5, workflow: '', branch: '', status: '', conclusion: null, createdAt: '' },
    ])
  })

  it('ignores extra fields and keeps a known projection', () => {
    const out = parseCiRuns([{
      databaseId: 9, workflowName: 'CI', headBranch: 'main', status: 'completed',
      conclusion: 'success', createdAt: '2026-06-10T10:00:00Z', noise: [1, 2, 3], more: { x: 1 },
    }])
    expect(out[0]).toEqual({ id: 9, workflow: 'CI', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-06-10T10:00:00Z' })
  })

  it('a float databaseId is accepted as-is (characterization — defensive, not strict)', () => {
    const out = parseCiRuns([{ databaseId: 9.5, workflowName: 'CI' }])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(9.5)
  })
})

// ── createPR — argv is injection-safe ──────────────────────────────────────────

describe('createPR — argv array is injection-safe (no shell, exact flags)', () => {
  beforeEach(() => mockExeca.mockReset())

  it('passes hostile option values verbatim as discrete argv elements; no --json, no shell', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/7\n', stderr: '' })
    const { createPR } = await import('../src/github.js')

    const hostile = {
      title: '"; rm -rf / #',
      body: '$(whoami) `id` && curl http://evil',
      head: 'feat/x; reboot',
      base: 'main && echo pwned',
    }
    await createPR('owner/repo', hostile)

    const [binary, args, options] = (mockExeca.mock.lastCall ?? []) as [string, string[], Record<string, unknown>]
    // never invokes a shell — execa is called with the bare binary + an argv array.
    expect(binary).toBe('gh')
    expect(Array.isArray(args)).toBe(true)
    expect(options?.shell).toBeUndefined()
    // exact flag order, with each hostile value a single discrete element (verbatim).
    expect(args).toEqual([
      'pr', 'create',
      '--repo', 'owner/repo',
      '--title', hostile.title,
      '--body', hostile.body,
      '--head', hostile.head,
      '--base', hostile.base,
    ])
    // `gh pr create` does NOT support --json — it must never be passed.
    expect(args).not.toContain('--json')
    // no element silently fused the values into one shell string.
    expect(args.filter(a => a === hostile.title)).toHaveLength(1)
  })
})

// ── pollOnce — graceful degrade when gh (fetch) throws ─────────────────────────

describe('__pollOnce — degrades gracefully when the fetch throws (gh absent)', () => {
  const projectIds: string[] = []

  afterAll(async () => {
    const { db } = await import('../src/db.js')
    for (const id of projectIds) {
      try { db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(id) } catch { /* ignore */ }
      try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
    }
  })

  it('a throwing fetch does not crash the poll, leaves the cache empty, and emits no broadcast; a later poll still works', async () => {
    const { __pollOnce, getGithubStatus } = await import('../src/github.js')
    const { projectsDb } = await import('../src/db.js')
    const { eventBus } = await import('../src/events.js')

    const id = uuid()
    projectsDb.insertProject.run({
      id, name: `s7-poll-${id.slice(0, 8)}`, localPath: '/tmp/s7-poll',
      githubRemote: 'owner/repo', workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
    })
    projectIds.push(id)

    const seen: Array<{ projectId: unknown }> = []
    const unsub = eventBus.onBroadcast(m => { if (m.type === 'github_update') seen.push({ projectId: m.projectId }) })
    try {
      // gh ENOENT for every project — pollOnce must catch per-project and resolve.
      await expect(__pollOnce(async () => { throw new Error('gh: command not found (ENOENT)') })).resolves.toBeUndefined()

      // cache for our project is untouched (never fetched), no broadcast fired for it.
      expect(getGithubStatus(id)).toEqual({ prs: [], ci: [], fetchedAt: null })
      expect(seen.filter(b => b.projectId === id)).toEqual([])

      // the reentrancy guard was released → a subsequent good poll writes + broadcasts.
      const pr = { number: 1, title: 't', state: 'OPEN', url: 'https://github.com/o/r/pull/1', checks: 'passing' as const }
      const ci = { id: 9, workflow: 'CI', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-06-10T10:00:00Z' }
      await __pollOnce(async () => ({ prs: [pr], ci: [ci] }))
      const after = getGithubStatus(id)
      expect(after.prs).toEqual([pr])
      expect(after.ci).toEqual([ci])
      expect(seen.filter(b => b.projectId === id).length).toBeGreaterThan(0)
    } finally {
      unsub()
    }
  })
})

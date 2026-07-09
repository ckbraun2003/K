/**
 * P2 E-06 — verify-status.ts: the verify→commit-status mapping (D-083) and the
 * PR-link gate. github.js is PARTIALLY mocked — publishCommitStatus becomes a spy
 * (no execa) while getGithubStatus stays REAL, so the link gate reads a genuinely
 * seeded github_cache row. Seeds runs + checkpoint events + github_cache directly.
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { PrInfo, VerifyResult } from '@k/shared'

// index.js fires its bootstrap at import time unless K_SKIP_BOOTSTRAP=1. Nothing
// here imports index.js, but set it defensively (the review-comments.test.ts seam).
vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

// Spy on publishCommitStatus only; keep getGithubStatus (and the rest) REAL so the
// link gate exercises a genuinely-seeded github_cache. vi.hoisted lifts the spy
// above the hoisted vi.mock factory so the factory may close over it.
const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn(async () => {}) }))
vi.mock('../src/github.js', async () => {
  const actual = await vi.importActual<typeof import('../src/github.js')>('../src/github.js')
  return { ...actual, publishCommitStatus: publishSpy }
})

import { runsDb, githubDb, eventsDb, projectsDb } from '../src/db.js'
import { getProject } from '../src/projects.js'
import { reviewBranchFor, verifyStatusFor, publishVerifyStatusIfLinked } from '../src/verify-status.js'

const RUN_ID = uuid()

function seedRun(runId: string, projectId: string | null): void {
  runsDb.insertRun.run({ id: runId, prompt: 'p', cwd: process.cwd(), worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId, createdAt: Date.now() })
}

function seedCheckpoint(runId: string, seq: number, sha: string, wave: number): void {
  eventsDb.insertEvent.run({
    id: uuid(), runId, seq, type: 'checkpoint', ts: 9,
    raw: JSON.stringify({ sha, tree: `t${wave}`, ref: `refs/k-checkpoints/${runId}`, wave }),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null,
    toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null,
    childLabel: null, contextTokens: null,
  })
}

function seedProject(githubRemote: string | null): string {
  const id = uuid()
  projectsDb.insertProject.run({ id, name: `vsl-${id.slice(0, 8)}`, localPath: process.cwd(),
    githubRemote, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now() })
  return id
}

function seedPrCache(projectId: string, prs: PrInfo[]): void {
  githubDb.upsertGithubCache.run({ projectId, kind: 'pr', payload: JSON.stringify(prs), fetchedAt: Date.now() })
}

function mkResult(runId: string, status: VerifyResult['status']): VerifyResult {
  return {
    runId, status, reason: status === 'error' ? 'boom' : null,
    commands: [{ label: 't', run: 'x', exitCode: 0, ok: true, durationMs: 5, outputTail: '' }],
    scope: null, startedAt: 1_000, completedAt: status === 'running' ? null : 42_000,
  }
}

describe('reviewBranchFor', () => {
  it('is k-review/<runId8>', () => {
    expect(reviewBranchFor('abcdef0123456789')).toBe('k-review/abcdef01')
  })
})

describe('verifyStatusFor — mapping (D-083)', () => {
  it('maps verify statuses per D-083 (skipped → null)', () => {
    const base = { runId: RUN_ID, reason: null, commands: [
      { label: 't', run: 'x', exitCode: 0, ok: true, durationMs: 5, outputTail: '' },
      { label: 'u', run: 'y', exitCode: 1, ok: false, durationMs: 5, outputTail: '' },
    ], scope: null, startedAt: 1_000, completedAt: 42_000 } satisfies Omit<VerifyResult, 'status'>
    expect(verifyStatusFor({ ...base, status: 'pass' })).toEqual({ state: 'success', description: '1/2 verify commands passed in 41s' })
    expect(verifyStatusFor({ ...base, status: 'fail' })!.state).toBe('failure')
    expect(verifyStatusFor({ ...base, status: 'running', completedAt: null })!.state).toBe('pending')
    expect(verifyStatusFor({ ...base, status: 'skipped' })).toBeNull()
  })

  it('error → { state: error, description: reason (clipped) }; null reason → fixed text', () => {
    const base = mkResult(RUN_ID, 'pass')
    expect(verifyStatusFor({ ...base, status: 'error', reason: 'disk full' })).toEqual({ state: 'error', description: 'disk full' })
    expect(verifyStatusFor({ ...base, status: 'error', reason: null })).toEqual({ state: 'error', description: 'verify error' })
  })
})

describe('publishVerifyStatusIfLinked — link gate', () => {
  it('publishes onto the FINAL checkpoint sha when an OPEN PR links the run', async () => {
    publishSpy.mockClear()
    const projectId = seedProject('acme/widgets')
    const runId = uuid(); seedRun(runId, projectId)
    seedCheckpoint(runId, 1, 'a'.repeat(40), 1)
    seedCheckpoint(runId, 2, 'f'.repeat(40), 2) // final
    seedPrCache(projectId, [{ number: 7, title: 'x', state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/7', checks: 'pending', headRefName: reviewBranchFor(runId) }])
    const published = await publishVerifyStatusIfLinked(mkResult(runId, 'pass'), getProject)
    expect(published).toBe(true)
    expect(publishSpy).toHaveBeenCalledWith('acme/widgets', 'f'.repeat(40),
      { state: 'success', description: expect.stringContaining('verify commands passed') })
  })

  it('is a no-op for: no project, no remote, unmatched PR, closed PR, no checkpoints', async () => {
    publishSpy.mockClear()
    // (a) run with no project
    const r1 = uuid(); seedRun(r1, null)
    expect(await publishVerifyStatusIfLinked(mkResult(r1, 'pass'), getProject)).toBe(false)
    // (b) project without a remote
    const p2 = seedProject(null); const r2 = uuid(); seedRun(r2, p2)
    seedCheckpoint(r2, 1, 'a'.repeat(40), 1)
    expect(await publishVerifyStatusIfLinked(mkResult(r2, 'pass'), getProject)).toBe(false)
    // (c) remote, but no PR head matches the review branch
    const p3 = seedProject('o/r'); const r3 = uuid(); seedRun(r3, p3)
    seedCheckpoint(r3, 1, 'a'.repeat(40), 1)
    seedPrCache(p3, [{ number: 1, title: 't', state: 'OPEN', url: 'u', checks: 'pending', headRefName: 'other-branch' }])
    expect(await publishVerifyStatusIfLinked(mkResult(r3, 'pass'), getProject)).toBe(false)
    // (d) the head matches but the PR is CLOSED
    const p4 = seedProject('o/r'); const r4 = uuid(); seedRun(r4, p4)
    seedCheckpoint(r4, 1, 'a'.repeat(40), 1)
    seedPrCache(p4, [{ number: 2, title: 't', state: 'CLOSED', url: 'u', checks: 'none', headRefName: reviewBranchFor(r4) }])
    expect(await publishVerifyStatusIfLinked(mkResult(r4, 'pass'), getProject)).toBe(false)
    // (e) linked OPEN PR but NO checkpoints
    const p5 = seedProject('o/r'); const r5 = uuid(); seedRun(r5, p5)
    seedPrCache(p5, [{ number: 3, title: 't', state: 'OPEN', url: 'u', checks: 'pending', headRefName: reviewBranchFor(r5) }])
    expect(await publishVerifyStatusIfLinked(mkResult(r5, 'pass'), getProject)).toBe(false)
    expect(publishSpy).not.toHaveBeenCalled()
  })

  it('does not publish a skipped verify even when a PR links (D-083)', async () => {
    publishSpy.mockClear()
    const projectId = seedProject('o/r'); const runId = uuid(); seedRun(runId, projectId)
    seedCheckpoint(runId, 1, 'a'.repeat(40), 1)
    seedPrCache(projectId, [{ number: 4, title: 't', state: 'OPEN', url: 'u', checks: 'none', headRefName: reviewBranchFor(runId) }])
    expect(await publishVerifyStatusIfLinked(mkResult(runId, 'skipped'), getProject)).toBe(false)
    expect(publishSpy).not.toHaveBeenCalled()
  })
})

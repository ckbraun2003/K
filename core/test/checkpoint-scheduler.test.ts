/**
 * P1 W0c — checkpoint scheduler extraction + TERMINAL SNAPSHOT (P0 carry-in #1).
 * Proves the final worktree state is ALWAYS checkpointed: a boundary dropped
 * while a snapshot is in flight (take-latest) is recovered by finalize(), and a
 * clean finalize adds no extra commit (identical-tree dedup).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCheckpoint, makeCheckpointScheduler, listRunCheckpoints, type CheckpointInfo } from '../src/checkpoints.js'
import { eventsDb, runsDb } from '../src/db.js'

const bases: string[] = []
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-sched-'))
  bases.push(base)
  repo = path.join(base, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@k.local']); git(repo, ['config', 'user.name', 'K'])
  git(repo, ['config', 'commit.gpgsign', 'false']); git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init'])
  worktree = path.join(base, 'wt')
  git(repo, ['worktree', 'add', '--detach', worktree])
})
afterEach(() => { for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* */ } } })

describe('makeCheckpointScheduler', () => {
  it('boundary → snapshot lands + emit fires; finalize dedups a clean tail', async () => {
    const emitted: CheckpointInfo[] = []
    const runId = `run-${Date.now()}`
    const sched = makeCheckpointScheduler({ worktree, runId, emit: (i) => emitted.push(i) })
    fs.writeFileSync(path.join(worktree, 'w1.txt'), 'wave 1\n')
    sched.onBoundary()
    const last = await sched.finalize()
    expect(emitted).toHaveLength(1)                 // finalize added NOTHING (identical tree)
    expect(last?.wave).toBe(1)
    expect(git(repo, ['rev-parse', `refs/k-checkpoints/${runId}`]).trim()).toBe(last!.sha)
  })

  it('a boundary dropped while busy is recovered by the terminal snapshot', async () => {
    const emitted: CheckpointInfo[] = []
    const runId = `run-${Date.now()}-b`
    let calls = 0
    let signalFirstCommitted!: () => void
    const firstCommitted = new Promise<void>(r => { signalFirstCommitted = r })
    // Wave 1 must capture ONLY w1.txt. The wrapper lets the REAL create finish
    // (add -A stages the CURRENT tree at create time — checkpoints.ts:70-79), THEN
    // holds the scheduler busy so the next boundary drops. Writing w2 before the
    // first create staged would fold both files into wave 1 and finalize() would
    // dedup the terminal snapshot to null (identical tree) — failing this test.
    const slowCreate: typeof createCheckpoint = async (wt, id, wave, prev) => {
      calls++
      const info = await createCheckpoint(wt, id, wave, prev)
      if (calls === 1) {
        signalFirstCommitted()
        await new Promise(r => setTimeout(r, 150))  // keep busy past the dropped boundary
      }
      return info
    }
    const sched = makeCheckpointScheduler({ worktree, runId, emit: (i) => emitted.push(i), create: slowCreate })
    fs.writeFileSync(path.join(worktree, 'w1.txt'), 'wave 1\n')
    sched.onBoundary()                              // in flight (slow resolve)
    await firstCommitted                            // wave 1 committed (w1 only); still busy
    fs.writeFileSync(path.join(worktree, 'w2.txt'), 'wave 2\n')
    sched.onBoundary()                              // DROPPED (busy)
    const last = await sched.finalize()             // terminal snapshot recovers w2
    expect(last).not.toBeNull()
    expect(git(repo, ['show', `${last!.sha}:w2.txt`])).toBe('wave 2\n')
    expect(emitted.length).toBe(2)                  // wave 1 + the terminal snapshot
    expect(emitted[1].wave).toBe(2)
  })

  it('finalize on a run with no boundaries and a clean tree stays null', async () => {
    const sched = makeCheckpointScheduler({ worktree, runId: 'run-clean', emit: () => {} })
    expect(await sched.finalize()).toBeNull()
  })
})

describe('listRunCheckpoints', () => {
  it('projects persisted checkpoint events (seq order, malformed raw skipped)', () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: repo, worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
    const base = { runId: rid, ts: 9, text: null, tool: null, tokensIn: null, tokensOut: null,
      costUsd: null, toolUseId: null, toolKind: null, toolInput: null, toolResult: null,
      toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null }
    eventsDb.insertEvent.run({ ...base, id: randomUUID(), seq: 3, type: 'checkpoint',
      raw: JSON.stringify({ sha: 'a'.repeat(40), tree: 'b'.repeat(40), ref: `refs/k-checkpoints/${rid}`, wave: 1 }) })
    eventsDb.insertEvent.run({ ...base, id: randomUUID(), seq: 8, type: 'checkpoint', raw: 'not json' })
    const list = listRunCheckpoints(rid)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ sha: 'a'.repeat(40), tree: 'b'.repeat(40),
      ref: `refs/k-checkpoints/${rid}`, wave: 1, seq: 3, ts: 9 })
  })
})

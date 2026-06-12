import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { runsDb, db } from '../src/db.js'

const TEST_ID = uuid()

afterAll(() => {
  db.prepare('DELETE FROM runs WHERE id = ?').run(TEST_ID)
})

describe('runsDb.clearRunWorktree', () => {
  it('sets worktree to null in the DB', () => {
    // Insert a synthetic run with a worktree path
    runsDb.insertRun.run({
      id: TEST_ID,
      prompt: 'test prompt',
      cwd: '/tmp/test-cwd',
      worktree: '/tmp/.worktrees/test-run',
      status: 'queued',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: null,
      createdAt: Date.now(),
    })

    // Verify worktree was stored
    const before = runsDb.getRun.get(TEST_ID) as { worktree: string | null } | undefined
    expect(before?.worktree).toBe('/tmp/.worktrees/test-run')

    // Clear the worktree
    runsDb.clearRunWorktree.run(TEST_ID)

    // Verify worktree is now null
    const after = runsDb.getRun.get(TEST_ID) as { worktree: string | null } | undefined
    expect(after?.worktree).toBeNull()
  })
})

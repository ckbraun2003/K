import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { retryRateSeries } from '../src/retry-metrics.js'

describe('retry-rate series', () => {
  // Delete events (child) before runs (parent) — foreign_keys=ON, events.run_id → runs(id).
  beforeEach(() => { db.prepare('DELETE FROM events').run(); db.prepare('DELETE FROM runs').run() })
  it('computes overall rate = retries / runs', () => {
    const now = Date.now()
    db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES ('a','p','.','.','done',?)`).run(now)
    db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,retry_of,created_at) VALUES ('b','p','.','.','done','a',?)`).run(now)
    const s = retryRateSeries(7, now + 1000)
    expect(s.overallRate).toBeCloseTo(0.5) // 1 retry / 2 runs
  })
})

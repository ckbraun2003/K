import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { retryRateSeries } from '../src/retry-metrics.js'

describe('retry-rate series', () => {
  // SHARED K_DATA_DIR: a blanket `DELETE FROM runs` FK-fails on sibling suites' RESTRICT
  // children. Scope to THIS suite's own ids only; delete the retry 'b' (self-FK runs.retry_of
  // → 'a', RESTRICT) before its parent 'a'.
  beforeEach(() => {
    db.prepare(`DELETE FROM events WHERE run_id IN ('a','b')`).run()
    db.prepare(`DELETE FROM runs WHERE id='b'`).run()
    db.prepare(`DELETE FROM runs WHERE id='a'`).run()
  })
  it('computes overall rate = retries / runs', () => {
    // retryRateSeries has only a LOWER time bound (created_at >= since). Seed at a distinctive
    // far-future epoch and query a window around it so leftover real-now sibling runs (present
    // under the shared-dir co-scheduled gate) fall below `since` and are excluded — this suite
    // measures ONLY its own two runs.
    const t0 = 4_102_444_800_000 // 2100-01-01
    db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES ('a','p','.','.','done',?)`).run(t0)
    db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,retry_of,created_at) VALUES ('b','p','.','.','done','a',?)`).run(t0)
    const s = retryRateSeries(7, t0 + 1000)
    expect(s.overallRate).toBeCloseTo(0.5) // 1 retry / 2 runs
  })
})

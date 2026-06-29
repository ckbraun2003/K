import { defineConfig } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

/**
 * NON-GATING quarantine project for the rigorous testing campaign.
 *
 * Holds RED-by-design tests that codify CONFIRMED faults (one per finding) so a
 * fault is tracked as an executable regression without breaking `main`'s green
 * CI. The gating `vitest.config.ts` excludes `test/regressions/**`; this config
 * runs ONLY those tests. A test here flips green (and moves to the gating suite)
 * when the operator fixes the underlying fault.
 *
 * Uses a SEPARATE K_DATA_DIR from the gating suite so a red run can never
 * corrupt gating-suite state. `passWithNoTests` keeps it green when empty.
 */
export default defineConfig({
  test: {
    include: ['test/regressions/**/*.test.ts'],
    passWithNoTests: true,
    // Same rationale as the gating config: one serial child process avoids both
    // the WAL-lock SQLITE_BUSY collision and the native better-sqlite3
    // worker-THREAD teardown segfault on Windows.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      // Honor an external override (parallel agent teams isolate per run);
      // default to a dir separate from the gating suite when unset.
      K_DATA_DIR: process.env.K_DATA_DIR ?? path.join(os.tmpdir(), 'k-core-regressions-data'),
      HARNESS_TOKEN: 'dev-token-change-me',
    },
  },
})

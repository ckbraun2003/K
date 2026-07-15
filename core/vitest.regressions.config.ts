import { defineConfig } from 'vitest/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

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
  // Match vitest.config.ts: resolve `@k/shared` to source (its `exports` now point
  // at built dist JS, which won't exist on a clean pre-build checkout).
  resolve: {
    alias: {
      '@k/shared': path.resolve(here, '../shared/src/types.ts'),
    },
  },
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
      // default to a dir separate from the gating suite when unset. NEVER the
      // repo's live data dir, though (H-1 guard — same rationale as
      // vitest.config.ts: an inherited live K_DATA_DIR must not bind a
      // regressions run to the real DB).
      K_DATA_DIR: (() => {
        const ext = process.env.K_DATA_DIR
        const fallback = path.join(os.tmpdir(), 'k-core-regressions-data')
        if (!ext) return fallback
        // H-1 guard, hardened (DEH-FU-6): canonicalize BOTH sides through the OS
        // (realpath resolves 8.3 short names like DATA~1 and junctions/symlinks)
        // and block the live dir AND anything inside it — the old exact-string
        // compare let `data\sub`, short paths, and junctions through.
        const canon = (p: string): string => {
          try { return fs.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
        }
        const live = canon(path.resolve(here, '../data'))
        const extCanon = canon(ext)
        if (extCanon === live || extCanon.startsWith(live + path.sep)) {
          console.warn('[vitest] K_DATA_DIR points at (or inside) the LIVE data dir — overriding to a temp dir (H-1 guard)')
          return fallback
        }
        return ext
      })(),
      HARNESS_TOKEN: 'dev-token-change-me',
    },
  },
})

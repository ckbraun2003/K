import { defineConfig, configDefaults } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Resolve `@k/shared` to its TypeScript SOURCE for tests. The shared package's
  // `exports` now points at built `dist` JS (so the compiled prod core is
  // runnable under plain node), but tests run BEFORE `build`, so pin the source
  // here — behavior is identical to the pre-build-fix node resolution, just explicit.
  resolve: {
    alias: {
      '@k/shared': path.resolve(here, '../shared/src/types.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The rigorous-testing campaign's confirmed-fault tests live in
    // test/regressions/** and are RED by design — keep them OUT of the gating
    // run (run them via vitest.regressions.config.ts / `pnpm test:regressions`).
    exclude: [...configDefaults.exclude, 'test/regressions/**'],
    // Every core test shares one on-disk SQLite file (a single-operator,
    // single-connection design — see db.ts). Run the whole suite in ONE child
    // process, serially:
    //  - `forks` (child process) not `threads`: the native better-sqlite3 addon
    //    can segfault (0xC0000005) during worker-THREAD teardown on Windows;
    //    a child-process exit tears native handles down cleanly.
    //  - `singleFork`: serial files → no concurrent writers colliding on the WAL
    //    lock (the intermittent SQLITE_BUSY / documented shared-temp-dir flake).
    // Serial execution is just one ordering the (already order-independent) suite
    // must tolerate, so it removes flakes without adding any. (Web has no DB.)
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Pin the harness token so the in-process buildApp() auth hook is
    // deterministic (integration tests inject `Bearer dev-token-change-me`).
    // Without this, resolveHarnessToken() would generate a random token at
    // import time and every authed inject would 401. Unit tests in auth.test.ts
    // pass env/file explicitly and are unaffected.
    env: {
      // Honor an externally-set K_DATA_DIR so parallel runners (campaign agent
      // teams, sharded CI) can each isolate their SQLite file; default unchanged
      // when unset, so existing local/CI runs behave exactly as before. This
      // also mitigates the shared-temp-dir flake when runs overlap.
      //
      // NEVER the repo's live data dir, though: an inherited live pointer (H-1 —
      // a lead running `pnpm core test` inside a run bound vitest to the LIVE DB
      // and deleted a live row) must not bind tests to the real DB even if it
      // leaks into the env vitest is invoked from. Case-insensitive compare
      // (Windows paths).
      K_DATA_DIR: (() => {
        const ext = process.env.K_DATA_DIR
        const live = path.resolve(here, '../data').toLowerCase()
        if (ext && path.resolve(ext).toLowerCase() !== live) return ext
        if (ext) console.warn('[vitest] K_DATA_DIR pointed at the LIVE data dir — overriding to a temp dir (H-1 guard)')
        return path.join(os.tmpdir(), 'k-core-vitest-data')
      })(),
      HARNESS_TOKEN: 'dev-token-change-me',
    },
  },
})

import { defineConfig, configDefaults } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The rigorous-testing campaign's confirmed-fault tests live in
    // test/regressions/** and are RED by design — keep them OUT of the gating
    // run (run them via vitest.regressions.config.ts / `pnpm test:regressions`).
    exclude: [...configDefaults.exclude, 'test/regressions/**'],
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
      K_DATA_DIR: process.env.K_DATA_DIR ?? path.join(os.tmpdir(), 'k-core-vitest-data'),
      HARNESS_TOKEN: 'dev-token-change-me',
    },
  },
})

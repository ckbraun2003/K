import { defineConfig } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Pin the harness token so the in-process buildApp() auth hook is
    // deterministic (integration tests inject `Bearer dev-token-change-me`).
    // Without this, resolveHarnessToken() would generate a random token at
    // import time and every authed inject would 401. Unit tests in auth.test.ts
    // pass env/file explicitly and are unaffected.
    env: {
      K_DATA_DIR: path.join(os.tmpdir(), 'k-core-vitest-data'),
      HARNESS_TOKEN: 'dev-token-change-me',
    },
  },
})

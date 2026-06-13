import { defineConfig } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { K_DATA_DIR: path.join(os.tmpdir(), 'k-core-vitest-data') },
  },
})

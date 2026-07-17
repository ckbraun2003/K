import { defineConfig } from 'vitest/config'

// The shared package has no DB/DOM dependency — schema (Zod) unit tests only,
// so a plain node environment with no aliasing/plugins is sufficient. Mirrors
// core/web's `test/**/*.test.ts` include convention.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})

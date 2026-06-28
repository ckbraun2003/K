import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * NON-GATING quarantine project for the rigorous testing campaign (web).
 *
 * RED-by-design tests codifying CONFIRMED web faults. The gating
 * `vitest.config.ts` excludes `test/regressions/**`; this config runs ONLY
 * those. `passWithNoTests` keeps it green when empty.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/regressions/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
  },
})

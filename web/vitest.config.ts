import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // React plugin gives the automatic JSX runtime so `.test.tsx` component
  // tests transform like the app does (the app uses jsx: 'react-jsx').
  plugins: [react()],
  // Match vite.config.ts: resolve `@k/shared` to source. The shared package's
  // `exports` now points at built `dist` JS (so the compiled prod core runs under
  // plain node); tests run before `build`, so pin the source explicitly here.
  resolve: {
    alias: {
      '@k/shared': path.resolve(here, '../shared/src/types.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Campaign confirmed-fault tests (RED by design) live in test/regressions/**
    // — excluded from the gating run; see web/vitest.regressions.config.ts.
    exclude: [...configDefaults.exclude, 'test/regressions/**'],
    // Only component tests (.test.tsx) run under jsdom; the existing .test.ts
    // suites stay in the default node environment (minimal blast radius).
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
  },
})

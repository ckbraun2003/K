import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // React plugin gives the automatic JSX runtime so `.test.tsx` component
  // tests transform like the app does (the app uses jsx: 'react-jsx').
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Only component tests (.test.tsx) run under jsdom; the existing .test.ts
    // suites stay in the default node environment (minimal blast radius).
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
  },
})

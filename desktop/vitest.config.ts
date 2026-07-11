import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the pure, Electron-free helpers are unit-tested here; the Electron
    // lifecycle (main.ts / preload.ts) is proven by the live launch smoke.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})

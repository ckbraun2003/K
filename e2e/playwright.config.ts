import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Isolated-stack config for the K user-testing swarm.
//
// Each persona agent runs THIS config with its own CORE_PORT / WEB_PORT so the
// swarm boots N independent K stacks in parallel — every stack gets a private
// SQLite-WAL DB (K_DATA_DIR derived from CORE_PORT) so single-operator state
// never collides. Playwright manages both servers (core + web) via `webServer`
// and waits on /api/health before any spec runs.
//
//   CORE_PORT=3101 WEB_PORT=4101 PERSONA=P01 pnpm e2e -- specs/P01.spec.ts
//
// Defaults match the normal single-stack dev ports (3001 / 5173), so a bare
// `pnpm e2e` works against a hand-started `pnpm dev` too.
// ---------------------------------------------------------------------------

const here = __dirname

const CORE_PORT = process.env.CORE_PORT ?? '3001'
const WEB_PORT = process.env.WEB_PORT ?? '5173'
const PERSONA = process.env.PERSONA ?? 'adhoc'

// Private, isolated data dir per core port — fresh DB, no WAL lock contention.
const DATA_DIR = path.resolve(here, '.data', `core-${CORE_PORT}`)

const coreEnv = {
  PORT: CORE_PORT,
  HOST: '127.0.0.1',
  HARNESS_TOKEN: 'dev-token-change-me',
  K_DATA_DIR: DATA_DIR,
  CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
  // Keep real dispatch safe & cheap when a spec does fire one (Hybrid budget).
  RUN_PERMISSION_MODE: process.env.RUN_PERMISSION_MODE ?? 'plan',
  // Autonomy OFF inside test stacks. chief-wake.ts defaults CHIEF_WAKE to ON with a
  // */15min cron — any suite run crossing a quarter-hour boundary was getting a REAL
  // autonomous "org check-in" dispatch (Chief -> lead relays) inside the shared test
  // core: unbudgeted spend, and enough spawned claude processes to starve the machine
  // and cascade-fail the rest of the run (observed 2026-07-12). Only the tests
  // themselves may dispatch. Mirrors scripts/smoke-ui-simpl.mts's isolated-core env.
  CHIEF_WAKE: '0',
  LEAD_DISPATCH_RELAY: '0',
  GRAPH_AUTO_REINDEX: '0',
  ENABLE_GITHUB_POLL: 'false',
}

const webEnv = {
  WEB_PORT,
  CORE_PORT,
  HARNESS_TOKEN: 'dev-token-change-me',
}

export default defineConfig({
  testDir: path.resolve(here, 'specs'),
  outputDir: path.resolve(here, 'reports', '_artifacts', PERSONA),
  // Personas drive a single-operator system; keep one worker per stack so a
  // spec's actions aren't interleaved with another's against the same core.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.resolve(here, 'reports', '_html', PERSONA), open: 'never' }],
    ['json', { outputFile: path.resolve(here, 'reports', '_json', `${PERSONA}.json`) }],
  ],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      // Core: tsx loader + the dev-env token bootstrap, listening on CORE_PORT.
      command: 'node --import tsx --import ./dev-env.mjs src/index.ts',
      cwd: path.resolve(here, '..', 'core'),
      url: `http://localhost:${CORE_PORT}/health`,
      env: coreEnv,
      timeout: 120_000,
      // Never adopt an unknown core on this port: an adopted process's autonomy
      // (CHIEF_WAKE/LEAD_DISPATCH_RELAY) and K_DATA_DIR are unverified and may be
      // the real ones (the exact T13/T16 incident vector) — always spawn our own.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Web: Vite dev server; reads CORE_PORT for the /api proxy + WS port.
      command: 'pnpm exec vite',
      cwd: path.resolve(here, '..', 'web'),
      url: `http://localhost:${WEB_PORT}`,
      env: webEnv,
      timeout: 120_000,
      // Never adopt an unknown process on this port either: a leftover dev
      // server may be proxying a different CORE_PORT (unverified autonomy/
      // data-dir on the other end) — always spawn our own, paired to coreEnv.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})

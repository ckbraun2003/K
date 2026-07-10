import { test, expect } from '@playwright/test'
import { captureConsole, gotoApp, screenshot, type ConsoleSink } from '../lib/harness'

// ===========================================================================
// P5.3a smoke — the Orchestrators roster + Orchestrator-detail screens. Drives a
// REAL browser (the repo's hard-won lesson: unit tests/builds do NOT catch
// module-eval blank screens). The core webServer runs full bootstrap, so
// seedProfiles() has stood up the five discipline leads; the roster renders them
// and the detail reuses the shared DelegationTree via leadNode.
//
// Run standalone: pnpm exec playwright test --config e2e/playwright.config.ts \
//   specs/orchestrators-smoke.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })
test.skip(!!process.env.PERSONA, 'orchestrators-smoke: run standalone, not in the persona swarm')

let sink: ConsoleSink

test.beforeEach(({ page }) => { sink = captureConsole(page) })

test('Orchestrators roster renders the five seeded leads', async ({ page }) => {
  await gotoApp(page, '#/org')
  await expect(page.locator('#root')).not.toBeEmpty()
  // P4 E-29: the Orchestrators grid is now the Org page's Roster segment (default).
  await expect(page.getByRole('heading', { name: 'Org' })).toBeVisible()
  await expect(page.getByTestId('seg-roster')).toHaveAttribute('aria-pressed', 'true')
  for (const id of ['lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']) {
    await expect(page.getByTestId(`orchestrator-card-${id}`)).toBeVisible({ timeout: 15_000 })
  }
  await screenshot(page, 'p53a-orchestrators-roster')
})

test('Orchestrator detail opens with tabs + the reused DelegationTree', async ({ page }) => {
  await gotoApp(page, '#/org')
  await page.getByTestId('orchestrator-open-lead-frontend').click()
  // Detail loaded: the canonical SegControl authority row + the reused tree root
  // (leadNode → root id = profile.id). P4 E-30: tab testids are now seg-${value}.
  await expect(page.getByTestId('seg-mcp')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('delegation-tree-node-lead-frontend')).toBeVisible()
  // The MCP · Authority panel (per-lead authority editor) mounts.
  await page.getByTestId('seg-mcp').click()
  await expect(page.getByTestId('orchestrator-panel-mcp')).toBeVisible()
  await screenshot(page, 'p53a-orchestrator-detail')
})

test.afterEach(() => {
  // A client SPA blank screen is almost always an uncaught throw at render/module-eval.
  expect(sink.pageErrors, `uncaught page errors:\n${sink.pageErrors.join('\n')}`).toEqual([])
  const fatal = sink.errors.filter(e => /is not defined|Cannot read|Minified React error/i.test(e))
  expect(fatal, `fatal console errors:\n${fatal.join('\n')}`).toEqual([])
})

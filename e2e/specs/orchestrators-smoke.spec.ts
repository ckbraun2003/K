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
  await gotoApp(page, '#/orchestrators')
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.getByRole('heading', { name: 'Orchestrators — domain leads' })).toBeVisible()
  for (const id of ['lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']) {
    await expect(page.getByTestId(`orchestrator-card-${id}`)).toBeVisible({ timeout: 15_000 })
  }
  await screenshot(page, 'p53a-orchestrators-roster')
})

test('Orchestrator detail opens with tabs + the reused DelegationTree', async ({ page }) => {
  await gotoApp(page, '#/orchestrators')
  await page.getByTestId('orchestrator-open-lead-frontend').click()
  // Detail loaded: the tabbed editor + the reused tree root (leadNode → root id = profile.id).
  await expect(page.getByTestId('orchestrator-tab-mcp')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('delegation-tree-node-lead-frontend')).toBeVisible()
  // The MCP · Authority panel (per-lead authority editor) mounts.
  await page.getByTestId('orchestrator-tab-mcp').click()
  await expect(page.getByTestId('orchestrator-panel-mcp')).toBeVisible()
  await screenshot(page, 'p53a-orchestrator-detail')
})

test.afterEach(() => {
  // A client SPA blank screen is almost always an uncaught throw at render/module-eval.
  expect(sink.pageErrors, `uncaught page errors:\n${sink.pageErrors.join('\n')}`).toEqual([])
  const fatal = sink.errors.filter(e => /is not defined|Cannot read|Minified React error/i.test(e))
  expect(fatal, `fatal console errors:\n${fatal.join('\n')}`).toEqual([])
})

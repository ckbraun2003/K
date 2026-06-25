import { test, expect } from '@playwright/test'
import { captureConsole, gotoApp, screenshot, type ConsoleSink } from '../lib/harness'
import { makeScratchRepo, cleanFixtures } from '../lib/fixtures'

// ===========================================================================
// UI-redesign smoke (vivid midnight-glass). Drives a REAL browser to verify the
// redesign's structural changes actually render & work — the lessons file is
// emphatic that build/unit tests cannot catch module-eval blank screens or the
// real DELETE→204→react-query path. Covers: labeled sidebar (no Docs rail),
// Bible→Artifacts tab rename, and the new project/task delete flows.
//
// Run standalone: pnpm exec playwright test --config e2e/playwright.config.ts \
//   e2e/specs/redesign-smoke.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })
test.skip(!!process.env.PERSONA, 'redesign-smoke: run standalone, not in the persona swarm')

let sink: ConsoleSink
const PERSONA = 'REDESIGN'
const NAME = 'redesign-smoke'

test.afterAll(() => cleanFixtures(PERSONA))

test.beforeEach(({ page }) => { sink = captureConsole(page) })

test('shell + labeled sidebar render; no top-level Docs rail item', async ({ page }) => {
  await gotoApp(page, '#/home')
  // Root is not blank (a module-eval crash would leave #root empty).
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.getByRole('heading', { name: 'Command Deck' })).toBeVisible()
  // Labeled nav destinations.
  await expect(page.getByRole('button', { name: /^Projects/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Runs/ })).toBeVisible()
  // Help stays (footer); Docs is no longer a top-level destination.
  await expect(page.getByRole('button', { name: /^Help/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Docs$/ })).toHaveCount(0)
  await screenshot(page, 'redesign-home')
})

test('fleet graph renders a canvas (legible nodes/edges)', async ({ page }) => {
  await gotoApp(page, '#/graph')
  // ForceGraph2D paints into a <canvas>; its presence proves the renderer mounted
  // (no AFRAME/module-eval crash) and the new node painter ran.
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1500) // let the force sim settle for a clean shot
  await screenshot(page, 'redesign-fleet-graph')
})

test('register → workspace shows Artifacts tab (not Bible) → add+delete a task', async ({ page }) => {
  const repo = makeScratchRepo(PERSONA, NAME)
  await gotoApp(page, '#/projects')

  await page.getByTestId('register-open').click()
  await expect(page.getByTestId('register-dialog')).toBeVisible()
  await page.getByTestId('register-name').fill(NAME)
  await page.getByTestId('register-source').fill(repo)
  await page.getByTestId('register-submit').click()

  // Card appears, dialog closed.
  const card = page.locator('[data-testid^="project-card-"]').filter({ hasText: NAME })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'redesign-projects')

  // Open the workspace → Artifacts tab present, Bible absent.
  await card.click()
  await expect(page.getByRole('tab', { name: 'Artifacts' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: 'Bible' })).toHaveCount(0)

  // Tasks tab: add a task, then delete it (the 204 path).
  await page.getByRole('tab', { name: 'Tasks' }).click()
  const taskTitle = 'smoke-task-to-delete'
  await page.getByPlaceholder('New task title…').fill(taskTitle)
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 10_000 })

  await page.getByLabel(`Delete task: ${taskTitle}`).click({ force: true })
  await page.getByTestId('task-delete-confirm').click()
  await expect(page.getByText(taskTitle)).toHaveCount(0, { timeout: 10_000 })
  await screenshot(page, 'redesign-tasks-after-delete')
})

test('delete the project via ConfirmDialog (DELETE→204) — card disappears', async ({ page }) => {
  await gotoApp(page, '#/projects')
  const card = page.locator('[data-testid^="project-card-"]').filter({ hasText: NAME })
  await expect(card).toBeVisible({ timeout: 15_000 })

  await card.hover()
  await card.getByLabel(`Delete project ${NAME}`).click({ force: true })
  await expect(page.getByTestId('project-delete')).toBeVisible()
  await page.getByTestId('project-delete-confirm').click()

  await expect(page.locator('[data-testid^="project-card-"]').filter({ hasText: NAME })).toHaveCount(0, { timeout: 15_000 })
  await screenshot(page, 'redesign-projects-after-delete')
})

test.afterEach(() => {
  // The hard-won lesson: a client SPA blank screen is almost always an uncaught
  // throw at render/module-eval. Fail loudly on any uncaught page error.
  expect(sink.pageErrors, `uncaught page errors:\n${sink.pageErrors.join('\n')}`).toEqual([])
  const fatal = sink.errors.filter(e => /AFRAME|is not defined|Cannot read|Minified React error/i.test(e))
  expect(fatal, `fatal console errors:\n${fatal.join('\n')}`).toEqual([])
})

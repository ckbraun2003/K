import { test, expect, type Page } from '@playwright/test'
import { captureConsole, gotoApp, screenshot, timed, type ConsoleSink } from '../lib/harness'
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// Wave C4 — single-stack manual repro of the P02/P04 High findings.
//
// Goal: decide whether P02 (#1,#2 register dialog never closed) and P04
// (#5,#6 verify-nav never reached #/verify/<id>) are REAL product defects or
// parallel-load/selector fragility in the swarm harness. This spec runs on ONE
// default-port stack (Playwright webServer, fresh DB, workers:1) and drives the
// flows via the NEW data-testids so selector ambiguity is removed as a variable.
//
// Run: pnpm exec playwright test --config e2e/playwright.config.ts \
//        e2e/specs/C4-repro.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })

// Standalone repro only: a bare persona-swarm run with a warm DB would collide on
// the repro-a/repro-b project names. The swarm sets PERSONA per stack (see
// e2e/playwright.config.ts / RUNBOOK.md); skip when that env is present.
test.skip(!!process.env.PERSONA, 'C4-repro: run standalone, not in the persona swarm')

let sink: ConsoleSink
const net4xx5xx: string[] = []

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
  page.on('response', (res) => {
    const s = res.status()
    if (s >= 400) net4xx5xx.push(`${s} ${res.request().method()} ${res.url()}`)
  })
})

async function registerViaTestid(page: Page, name: string, source: string) {
  await page.getByTestId('register-open').click()
  const dialog = page.getByTestId('register-dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('register-name').fill(name)
  await page.getByTestId('register-source').fill(source)
  await page.getByTestId('register-submit').click()
}

test('P02 repro — register a local-path fixture; dialog closes; card appears', async ({ page }) => {
  const repoA = makeScratchRepo('C4', 'repro-a')
  await gotoApp(page, '#/projects')
  await screenshot(page, 'C4-projects-before')

  const { ms } = await timed(async () => {
    await registerViaTestid(page, 'repro-a', repoA)
    // The decisive assertions: the dialog must HIDE and the card must appear.
    await expect(page.getByTestId('register-dialog')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText('repro-a', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  })
  await screenshot(page, 'C4-projects-after-a')
  // eslint-disable-next-line no-console
  console.log(`[C4] P02 register #1: dialog closed + card visible in ${ms}ms`)
  expect(ms).toBeLessThan(15_000)
})

test('P02 repro — register a SECOND fixture; dialog closes again', async ({ page }) => {
  const repoB = makeScratchRepo('C4', 'repro-b')
  await gotoApp(page, '#/projects')

  // Self-sufficient: don't assume repro-a persisted from test 1. If it isn't on
  // the grid yet (e.g. running this test in isolation), register it first so the
  // ">= 2 cards coexist" assertion is meaningful regardless of run order.
  const cards = page.locator('[data-testid^="project-card-"]')
  if (await page.getByText('repro-a', { exact: false }).count() === 0) {
    const repoA = makeScratchRepo('C4', 'repro-a')
    await registerViaTestid(page, 'repro-a', repoA)
    await expect(page.getByTestId('register-dialog')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText('repro-a', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  }

  const { ms } = await timed(async () => {
    await registerViaTestid(page, 'repro-b', repoB)
    await expect(page.getByTestId('register-dialog')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText('repro-b', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  })
  // Both fixtures coexist on the grid (>= 2 registered cards).
  await expect(page.getByText('repro-a', { exact: false }).first()).toBeVisible()
  expect(await cards.count()).toBeGreaterThanOrEqual(2)
  await screenshot(page, 'C4-projects-two-cards')
  // eslint-disable-next-line no-console
  console.log(`[C4] P02 register #2: dialog closed + card visible in ${ms}ms`)
  expect(ms).toBeLessThan(15_000)
})

test('P04 repro — ▶ Run verification navigates to #/verify/<id>', async ({ page }) => {
  await gotoApp(page, '#/projects')
  // Find repro-a's card by testid: the card id is the project id, so grab the
  // verify button scoped to the card whose text is repro-a.
  const cardA = page.locator('[data-testid^="project-card-"]', { hasText: 'repro-a' }).first()
  await expect(cardA).toBeVisible({ timeout: 10_000 })
  // Extract the registered project's id from the card testid so we can assert the
  // URL lands on THIS project — not just on some verify surface (guards a false
  // pass if routing landed on the wrong card/id).
  const cardTestid = await cardA.getAttribute('data-testid')
  const id = cardTestid?.replace(/^project-card-/, '')
  expect(id, 'repro-a card should expose a project id').toBeTruthy()

  const { ms } = await timed(async () => {
    // Scope the (now per-id) verify button to repro-a's card.
    await cardA.getByTestId(`project-verify-btn-${id}`).click()
    await page.waitForURL(/#\/verify\/[0-9a-f-]+/i, { timeout: 10_000 })
  })
  await screenshot(page, 'C4-verify-nav')
  const url = page.url()
  // eslint-disable-next-line no-console
  console.log(`[C4] P04 verify-nav reached ${url} in ${ms}ms`)
  // The URL must carry repro-a's own id, not merely match the verify shape.
  expect(url).toContain(`#/verify/${id}`)
  // The verify surface has known testids (verify-rerun); assert it actually rendered.
  await expect(page.getByTestId('verify-rerun')).toBeVisible({ timeout: 10_000 })
})

test.afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`[C4] console.errors: ${sink?.errors.length ?? 0}`)
  if (sink?.errors.length) console.log('[C4] errors:\n' + sink.errors.join('\n'))
  // eslint-disable-next-line no-console
  console.log(`[C4] pageErrors: ${sink?.pageErrors.length ?? 0}`)
  if (sink?.pageErrors.length) console.log('[C4] pageErrors:\n' + sink.pageErrors.join('\n'))
  // eslint-disable-next-line no-console
  console.log(`[C4] HTTP >=400 responses (${net4xx5xx.length}):\n` + net4xx5xx.join('\n'))

  // Fix #5: don't let a server error pass off as "harness flakiness". Each entry
  // is "<status> <method> <url>". Flag any 5xx anywhere, plus any 4xx on the
  // register/verify request paths (the flows under test). Favicon and Vite HMR
  // probes are genuinely-expected dev-server noise and are filtered explicitly.
  const EXPECTED_NOISE = /\/favicon\.ico|\/@vite\/|\/@react-refresh|\.hot-update\./
  const FLOW_PATHS = /\/(api\/)?projects|\/(api\/)?verify/
  const unexpected = net4xx5xx.filter((entry) => {
    if (EXPECTED_NOISE.test(entry)) return false
    const status = Number(entry.slice(0, 3))
    const url = entry.slice(entry.indexOf(' ', 4) + 1)
    if (status >= 500) return true // any 5xx is a product/server defect
    return FLOW_PATHS.test(url) // 4xx only counts on the flows under test
  })
  expect(unexpected, `unexpected 4xx/5xx during C4 repro:\n${unexpected.join('\n')}`).toEqual([])
})

import { test, expect } from '@playwright/test'
import {
  captureConsole,
  gotoApp,
  waitForWs,
  screenshot,
  timed,
  writeFindings,
  type Finding,
  type ConsoleSink,
} from '../lib/harness'

// ===========================================================================
// P01 — First-Run Operator
// Charter: cold boot, 503 "core starting" handling, Home empty states, metric
// cards, Getting Started, Help deep-link, tooltips, and the discoverability of
// "what do I do first" against bible §10. Adversarial + critical: time every
// interaction, flag >1s with no feedback, record claims-vs-reality gaps.
//
// This is also the REFERENCE spec for the swarm — copy its shape for P02..P10.
// ===========================================================================

const CHARTER =
  'First-run operator: cold boot, empty states, Getting Started, Help, discoverability vs bible §10.'
const findings: Finding[] = []
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

test('home boots with live WS and renders the metrics row', async ({ page }) => {
  // Warm up first: the very first navigation pays a one-time Vite dep-optimize
  // cost that would otherwise masquerade as an app perf problem. Time the
  // SECOND, warm navigation.
  await gotoApp(page, '#/home')
  const { ms } = await timed(() => gotoApp(page, '#/home'))

  // Metric cards documented on Home (Tokens/Cost/Active/Runs today/Total).
  await expect(page.getByText('Tokens today')).toBeVisible()
  await expect(page.getByText('Active runs')).toBeVisible()
  await expect(page.getByText('Total runs')).toBeVisible()

  await screenshot(page, 'P01-home')

  if (ms > 5000) {
    findings.push({
      title: 'Cold load to interactive Home is slow',
      severity: 'Med',
      category: 'Perf',
      surface: 'Home',
      repro: 'Boot a fresh stack, navigate to #/home, wait for WS-connected.',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${ms}ms to reach WS-connected + metrics visible.`,
      evidence: 'reports/screens/P01-home.png; timing from harness.timed().',
    })
  }
})

test('empty state forces Getting Started and a clear first action', async ({ page }) => {
  await gotoApp(page, '#/home')

  // With zero projects, GettingStarted is forced open and the empty-state CTA shows.
  const cta = page.getByRole('button', { name: /register your first project/i })
  await expect(cta).toBeVisible()
  await screenshot(page, 'P01-empty-state')

  // Discoverability check: a brand-new operator should see guidance, not a void.
  const hasGuidance = await page
    .getByText(/getting started|register/i)
    .first()
    .isVisible()
    .catch(() => false)
  if (!hasGuidance) {
    findings.push({
      title: 'No first-run guidance surfaced on empty Home',
      severity: 'High',
      category: 'UX',
      surface: 'Home / GettingStarted',
      repro: 'Fresh stack (no projects) → open #/home.',
      expected: 'Bible §10 promises in-app Getting Started + clear first step.',
      actual: 'No getting-started/registration guidance was visible.',
      evidence: 'reports/screens/P01-empty-state.png',
    })
  }
})

test('Help deep-links into the bible (Docs)', async ({ page }) => {
  await gotoApp(page, '#/home')

  const { ms } = await timed(async () => {
    await page.getByRole('button', { name: 'Help' }).click()
    // Help is a deep-link to docs/project-bible — assert we land in Docs.
    await page.waitForURL(/#\/docs/, { timeout: 15_000 })
  })
  await waitForWs(page)
  await screenshot(page, 'P01-help-docs')

  if (ms > 2000) {
    findings.push({
      title: 'Help → Docs navigation has no loading feedback',
      severity: 'Low',
      category: 'Perf',
      surface: 'Sidebar Help / Docs',
      repro: 'Home → click Help (❔) → bible loads.',
      expected: 'Sub-second nav, or a spinner if the bible is large.',
      actual: `Took ${ms}ms to land on the Docs view.`,
      evidence: 'reports/screens/P01-help-docs.png',
    })
  }
})

test('sidebar tooltips/labels are present for discoverability', async ({ page }) => {
  await gotoApp(page, '#/home')
  // Icon-only nav relies on title/aria-label for discoverability.
  for (const label of ['Home', 'Projects', 'Fleet Graph', 'Runs', 'Skills', 'Docs', 'Help']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }
})

test.afterEach(async () => {
  // Fail-loud lesson: a client-rendered SPA can crash at module-eval time
  // without any failing assertion. Record console/page errors as findings.
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during first-run flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Home / first-run',
      repro: 'Drive the first-run flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    findings.push({
      title: 'console.error logged during first-run flow',
      severity: 'High',
      category: 'Bug',
      surface: 'Home / first-run',
      repro: 'Drive the first-run flow with the console attached.',
      expected: 'No console.error in a clean session.',
      actual: sink.errors.join('\n').slice(0, 800),
      evidence: 'page.on("console") capture',
    })
  }
})

test.afterAll(() => {
  writeFindings('P01', CHARTER, findings)
})

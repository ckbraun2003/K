import { test, expect, type Page } from '@playwright/test'
import { captureConsole, gotoApp, screenshot, writeFindings, type ConsoleSink, type Finding } from '../lib/harness'

// ===========================================================================
// UI Adjustments live smoke (D-129..D-132). Drives a real browser against the
// auto-booted, isolated stack (seeded org/agents, NO pipeline runs, NO indexed
// project graph) to prove the four adjustment lanes render:
//   1. Home chat (D-129) — thread rail + message dock + glass/font.
//   2. Runs consolidation (D-130) — Agent Runs / Pipelines segmented control.
//   3. Glass/palette (D-131) — Settings > Appearance wallpaper picker.
//   4. Knowledge/fleet graph (D-132) — Org > Graph tab (ForceGraph3D canvas).
//
// Resilient per RUNBOOK.md: exploratory interactions are wrapped in try/catch
// and converted into `findings`; only the WS-connected boot (via gotoApp) is
// hard-asserted. writeFindings always runs so reports/UIADJ.md exists.
//
// Run standalone:
//   pnpm exec playwright test --config e2e/playwright.config.ts \
//     specs/ui-adjustments-smoke.spec.ts --reporter=list --trace off
// ===========================================================================

test.describe.configure({ mode: 'serial' })

const PERSONA = 'UIADJ'
const CHARTER =
  'UI Adjustments program live smoke (D-129..D-132): Home chat rail, Runs consolidation ' +
  'segments, glass/palette wallpaper picker, org/fleet graph render — on a fresh isolated ' +
  'stack with seeded org/agents but no pipeline runs and no indexed project graph.'

const findings: Finding[] = []
let sink: ConsoleSink

test.beforeEach(({ page }) => {
  sink = captureConsole(page)
})

/** The 7-page help guide auto-opens on a first-run stack and intercepts pointer events. */
async function dismissHelp(page: Page): Promise<void> {
  const guide = page.getByTestId('help-guide')
  await guide.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { /* not auto-opened */ })
  if (await guide.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close guide' }).click().catch(() => { /* best effort */ })
    await guide.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { /* best effort */ })
  }
}

/** gotoApp (nav + WS-green, hard-asserted) then dismiss the first-run help overlay. */
async function openApp(page: Page, hash: string): Promise<void> {
  await gotoApp(page, hash)
  await dismissHelp(page)
}

/** Fold this test's captured console/page errors into findings (never throws). */
function recordConsoleFindings(surface: string) {
  if (sink.pageErrors.length) {
    findings.push({
      title: `Uncaught page error(s) on ${surface}`,
      severity: 'High',
      category: 'Bug',
      surface,
      repro: `Navigate to ${surface}`,
      expected: 'No uncaught page errors.',
      actual: sink.pageErrors.slice(0, 5).join(' | ').slice(0, 500),
      evidence: sink.pageErrors.join('\n').slice(0, 2000),
    })
  }
  const fatal = sink.errors.filter(e => /AFRAME|is not defined|Cannot read|Minified React error/i.test(e))
  if (fatal.length) {
    findings.push({
      title: `Fatal console error(s) on ${surface}`,
      severity: 'High',
      category: 'Bug',
      surface,
      repro: `Navigate to ${surface}`,
      expected: 'No fatal console errors.',
      actual: fatal.slice(0, 5).join(' | ').slice(0, 500),
      evidence: fatal.join('\n').slice(0, 2000),
    })
  }
}

// --- 1. Home chat (D-129) ---------------------------------------------------

test('1. Home chat: thread rail + message dock render', async ({ page }) => {
  await openApp(page, '#/home')
  await screenshot(page, 'uiadj-1-home-chat')

  try {
    await expect(page.getByTestId('chat-thread-rail')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Chats rail (chat-thread-rail) not visible on Home',
      severity: 'High',
      category: 'Bug',
      surface: '#/home',
      repro: "gotoApp('#/home')",
      expected: 'The Chats rail [data-testid=chat-thread-rail] renders.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-1-home-chat.png',
    })
  }

  try {
    // dock-input is the composer itself — the definitive proof the dock rendered.
    // (message-dock-bar is its outer bar chrome; asserting both via .or() double-
    // matches and trips Playwright's strict-mode single-element rule.)
    await expect(page.getByTestId('dock-input')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Message dock not visible on Home',
      severity: 'High',
      category: 'Bug',
      surface: '#/home',
      repro: "gotoApp('#/home')",
      expected: 'The message dock (bar variant, [data-testid=message-dock-bar]/[dock-input]) renders inline on Home.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-1-home-chat.png',
    })
  }

  try {
    const rows = page.locator('[data-testid^="chat-thread-row-"]')
    const texts = await rows.allTextContents()
    const suspicious = texts.filter(t => /orchestrator/i.test(t))
    if (suspicious.length > 0) {
      findings.push({
        title: 'Non-K "orchestrator" thread appears in the Chats rail',
        severity: 'Med',
        category: 'Bug',
        surface: '#/home',
        repro: "gotoApp('#/home'), inspect chat-thread-row-* text",
        expected: 'The Chats rail lists only K conversations, not orchestrator/lead threads.',
        actual: suspicious.join(' | ').slice(0, 300),
        evidence: 'uiadj-1-home-chat.png',
      })
    } else if (texts.length === 0) {
      findings.push({
        title: 'No chat threads seeded — Chats rail rendered empty',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: '#/home',
        repro: "gotoApp('#/home')",
        expected: 'n/a — informational only.',
        actual: 'Fresh stack has no seeded chat threads; rail shows its empty state. Cannot verify row contents.',
        evidence: 'uiadj-1-home-chat.png',
      })
    }
  } catch (err) {
    findings.push({
      title: 'Could not inspect Chats rail thread rows',
      severity: 'Low',
      category: 'Missing',
      surface: '#/home',
      repro: "gotoApp('#/home'), locate chat-thread-row-*",
      expected: 'Rows are inspectable for orchestrator-thread leakage.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-1-home-chat.png',
    })
  }

  recordConsoleFindings('#/home')
})

// --- 2. Runs consolidation (D-130) -----------------------------------------

test('2. Runs: Agent Runs / Pipelines segments + archived toggle', async ({ page }) => {
  await openApp(page, '#/runs')
  await screenshot(page, 'uiadj-2-runs-agent')

  try {
    await expect(page.getByTestId('seg-agent')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('seg-pipelines')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Runs segmented control missing Agent Runs / Pipelines segments',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs')",
      expected: 'Segmented control shows both "Agent Runs" ([data-testid=seg-agent]) and "Pipelines" ([data-testid=seg-pipelines]).',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-2-runs-agent.png',
    })
  }

  try {
    await expect(page.getByTestId('run-show-archived')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: '"Show archived" toggle missing on Agent Runs list',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs')",
      expected: 'A "Show archived" checkbox ([data-testid=run-show-archived]) renders in the run list header.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-2-runs-agent.png',
    })
  }

  try {
    const selectRows = page.locator('[data-testid^="run-select-"]')
    const n = await selectRows.count()
    if (n === 0) {
      findings.push({
        title: 'No runs seeded — bulk multi-select checkboxes not exercisable',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: '#/runs',
        repro: "gotoApp('#/runs')",
        expected: 'n/a — informational only.',
        actual: 'Fresh stack has no runs, so no run-select-<id> rows exist to verify the bulk multi-select affordance.',
        evidence: 'uiadj-2-runs-agent.png',
      })
    }
  } catch { /* non-fatal, list may still be loading */ }

  try {
    await page.getByTestId('seg-pipelines').click()
    await page.waitForURL(/#\/runs\/pipelines/, { timeout: 5_000 })
    await screenshot(page, 'uiadj-2-runs-pipelines')
  } catch (err) {
    findings.push({
      title: 'Clicking the Pipelines segment did not navigate to #/runs/pipelines',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs'); click seg-pipelines",
      expected: 'URL hash becomes #/runs/pipelines and the Pipelines pane renders.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-2-runs-pipelines (not captured, see error).',
    })
  }

  recordConsoleFindings('#/runs')
})

test('2b. Runs: direct #/runs/pipelines deep-link does not 404 or loop', async ({ page }) => {
  await openApp(page, '#/runs/pipelines')
  await screenshot(page, 'uiadj-2b-runs-pipelines-direct')

  const hash = await page.evaluate(() => location.hash)
  if (!hash.includes('runs/pipelines')) {
    findings.push({
      title: 'Direct #/runs/pipelines deep-link redirected away',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs/pipelines',
      repro: "gotoApp('#/runs/pipelines') directly",
      expected: 'Hash stays on #/runs/pipelines (or an equivalent canonical runs/pipelines route).',
      actual: `Resolved hash: ${hash}`,
      evidence: 'uiadj-2b-runs-pipelines-direct.png',
    })
  }

  try {
    await expect(page.getByTestId('seg-pipelines')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Direct #/runs/pipelines deep-link did not select the Pipelines segment',
      severity: 'Med',
      category: 'Bug',
      surface: '#/runs/pipelines',
      repro: "gotoApp('#/runs/pipelines') directly",
      expected: 'seg-pipelines shows aria-pressed=true on direct load.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-2b-runs-pipelines-direct.png',
    })
  }

  recordConsoleFindings('#/runs/pipelines (direct)')
})

// --- 3. Glass/palette (D-131) -----------------------------------------------

test('3. Glass/palette: Settings > Appearance wallpaper picker renders', async ({ page }) => {
  await openApp(page, '#/settings')
  await screenshot(page, 'uiadj-3-settings-top')

  try {
    const section = page.getByTestId('appearance-section')
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible({ timeout: 10_000 })
    // ui-adjustments Round 4 dropped the gradient kind + <select>s in favour
    // of a Solid|Image SegControl (seg-solid/seg-image).
    await expect(page.getByTestId('seg-solid')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('seg-image')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('background-preview')).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'uiadj-3-settings-appearance')
  } catch (err) {
    findings.push({
      title: 'Settings > Appearance wallpaper picker did not render',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings',
      repro: "gotoApp('#/settings'); scroll to appearance-section",
      expected: 'appearance-section, the seg-solid/seg-image wallpaper-kind toggle, and background-preview all render.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-3-settings-appearance.png (or -top if it failed before scroll).',
    })
  }

  recordConsoleFindings('#/settings')
})

// --- 4. Knowledge / fleet graph (D-132) -------------------------------------

test('4. Org/fleet graph: canvas renders (or is noted as data-absent)', async ({ page }) => {
  await openApp(page, '#/org')
  await screenshot(page, 'uiadj-4-org-roster')

  try {
    await page.getByTestId('seg-graph').click()
    await page.waitForURL(/#\/agents\/org\/graph/, { timeout: 5_000 })
  } catch (err) {
    findings.push({
      title: 'Could not navigate to the Org Graph sub-tab',
      severity: 'High',
      category: 'Bug',
      surface: '#/org',
      repro: "gotoApp('#/org'); click seg-graph",
      expected: 'Clicking the Graph segment navigates to #/agents/org/graph.',
      actual: String(err).slice(0, 300),
      evidence: 'uiadj-4-org-roster.png',
    })
  }

  await screenshot(page, 'uiadj-4-org-graph-1')

  const emptyState = page.getByText('No projects registered.')
  const isEmpty = await emptyState.isVisible().catch(() => false)

  if (isEmpty) {
    findings.push({
      title: 'Org > Graph (fleet graph) has no data on a fresh stack — no registered projects',
      severity: 'Low',
      category: 'Docs-mismatch',
      surface: '#/agents/org/graph',
      repro: "gotoApp('#/agents/org/graph')",
      expected: 'n/a — informational only.',
      actual:
        'GraphView (Org > Graph) is driven by GET /api/projects, not by org/agent roster data; a fresh stack ' +
        'has seeded agent profiles but zero registered projects, so it renders the "No projects registered." ' +
        'empty state instead of a ForceGraph3D canvas. Cannot verify canvas render or rotation motion without ' +
        'registering a project first.',
      evidence: 'uiadj-4-org-graph-1.png',
    })
  } else {
    try {
      const canvas = page.locator('canvas').first()
      await expect(canvas).toBeVisible({ timeout: 15_000 })
      const box = await canvas.boundingBox()
      if (!box || box.width === 0 || box.height === 0) {
        findings.push({
          title: 'Org/fleet graph canvas has zero size',
          severity: 'High',
          category: 'Bug',
          surface: '#/agents/org/graph',
          repro: "gotoApp('#/agents/org/graph')",
          expected: 'The ForceGraph3D <canvas> has a non-zero bounding box.',
          actual: JSON.stringify(box),
          evidence: 'uiadj-4-org-graph-1.png',
        })
      }
      await page.waitForTimeout(2000)
      await screenshot(page, 'uiadj-4-org-graph-2')
    } catch (err) {
      findings.push({
        title: 'Org/fleet graph canvas did not render',
        severity: 'Critical',
        category: 'Bug',
        surface: '#/agents/org/graph',
        repro: "gotoApp('#/agents/org/graph')",
        expected: 'A <canvas> (ForceGraph3D/WebGL) renders, not a blank/white pane.',
        actual: String(err).slice(0, 300),
        evidence: 'uiadj-4-org-graph-1.png',
      })
    }
  }

  recordConsoleFindings('#/agents/org/graph')
})

test.afterAll(() => {
  const file = writeFindings(PERSONA, CHARTER, findings)
  console.log(`[${PERSONA}] wrote ${findings.length} finding(s) to ${file}`)
})

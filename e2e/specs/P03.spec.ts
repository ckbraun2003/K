import { test, expect, type Page } from '@playwright/test'
import {
  captureConsole,
  gotoApp,
  waitForWs,
  openCommandBar,
  screenshot,
  timed,
  writeFindings,
  type Finding,
  type ConsoleSink,
} from '../lib/harness'
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// P03 — Agent Dispatcher
// Charter: ⌘K command bar (button + Ctrl/Cmd+K), @project autocomplete, the
// dispatch → "confirm card" preview, ONE real plan-mode run end-to-end (live
// console stream, run list, run_update, terminal status), run-list filters +
// past-run selection, the kill affordance, and the "Create PR from Run"
// graceful-failure boundary (no GitHub remote). Adversarial: time everything,
// flag laggy streaming / missing feedback, work around missing selectors.
// ===========================================================================

const CHARTER =
  'Agent dispatcher: ⌘K bar (button + shortcut), @project autocomplete, dispatch confirm/preview, ONE real plan-mode run end-to-end, run filters + selection, kill affordance, Create-PR graceful failure with no remote.'
const findings: Finding[] = []
let sink: ConsoleSink

// One real-run budget — guard so a flaky retry can never fire a second dispatch.
let realRunFired = false
// Capture details of the real run for the cross-test PR / kill checks.
let realRunId: string | null = null
let realRunTerminalStatus: string | null = null
let fixturePath = ''
const FIXTURE_NAME = 'dispatch-a'

test.describe.configure({ mode: 'serial' })

function add(f: Finding) {
  findings.push(f)
}

/** Screenshot that can never abort a test (full-page shots can flake under
 *  live animation/scroll load). Failures are swallowed — evidence is best-effort. */
async function shot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* best-effort evidence only */
  }
}

/** Open ⌘K and wait for its input to be focusable. Returns the input locator. */
async function commandInput(page: Page) {
  const input = page.getByPlaceholder(/Ask K/i)
  await expect(input).toBeVisible({ timeout: 10_000 })
  return input
}

test.beforeAll(() => {
  // Local-only throwaway repo to register / dispatch against. No remote.
  fixturePath = makeScratchRepo('P03', FIXTURE_NAME)
})

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// ---------------------------------------------------------------------------
// 1. ⌘K opens both ways: the TopBar button AND the Ctrl/Cmd+K shortcut.
// ---------------------------------------------------------------------------
test('command bar opens via button and via Ctrl/Cmd+K, closes on Escape', async ({ page }) => {
  await gotoApp(page, '#/home')
  // warm nav so the first Vite optimize cost isn't blamed on the bar
  await gotoApp(page, '#/home')

  // (a) Button
  try {
    const { ms } = await timed(async () => {
      await openCommandBar(page)
      await commandInput(page)
    })
    await shot(page, 'P03-cmdbar-button')
    if (ms > 1000) {
      add({
        title: 'Command bar (button) slow to appear',
        severity: 'Low',
        category: 'Perf',
        surface: '⌘K / TopBar button',
        repro: 'Click the "Ask K or jump anywhere" button.',
        expected: 'Palette appears within ~1s.',
        actual: `Took ${ms}ms for the input to be visible.`,
        evidence: 'reports/screens/P03-cmdbar-button.png; harness.timed()',
      })
    }
    await page.keyboard.press('Escape')
    await expect(page.getByPlaceholder(/Ask K/i)).toBeHidden({ timeout: 5000 })
  } catch (e) {
    add({
      title: 'Command bar could not be opened via the TopBar button',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K / TopBar button',
      repro: 'Home → click the ⌘K button.',
      expected: 'Command palette opens with a focusable input.',
      actual: String(e).slice(0, 400),
      evidence: 'openCommandBar threw',
    })
  }

  // (b) Keyboard shortcut. Use ControlOrMeta so it works cross-platform.
  try {
    await page.keyboard.press('ControlOrMeta+k')
    await commandInput(page)
    await shot(page, 'P03-cmdbar-shortcut')
    // Toggle behavior: the Shell binds Ctrl+K to a toggle, so pressing again should close.
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByPlaceholder(/Ask K/i)).toBeHidden({ timeout: 5000 })
  } catch (e) {
    add({
      title: 'Ctrl/Cmd+K shortcut does not open (or toggle) the command bar',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K / keyboard shortcut',
      repro: 'Press Ctrl+K (or Cmd+K) anywhere in the app.',
      expected: 'Palette opens; pressing again toggles it closed (Shell binds a toggle).',
      actual: String(e).slice(0, 400),
      evidence: 'page.keyboard ControlOrMeta+k',
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Register the fixture project (prereq for @autocomplete + project dispatch).
// ---------------------------------------------------------------------------
test('register the local fixture project', async ({ page }) => {
  await gotoApp(page, '#/projects')
  try {
    await page.getByRole('button', { name: /register project/i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 8000 })
    await dialog.getByPlaceholder(/name/i).fill(FIXTURE_NAME)
    await dialog.getByPlaceholder(/path.*repo|github/i).fill(fixturePath)
    const { ms } = await timed(async () => {
      await dialog.getByRole('button', { name: /Register/i }).click()
      // The card appears once the projects query invalidates + refetches.
      await expect(page.getByText(FIXTURE_NAME).first()).toBeVisible({ timeout: 20_000 })
    })
    await shot(page, 'P03-project-registered')
    if (ms > 5000) {
      add({
        title: 'Registering a local project is slow with no progress feedback',
        severity: 'Med',
        category: 'Perf',
        surface: 'Projects / Register modal',
        repro: 'Register a local-path project and wait for the card to appear.',
        expected: 'Sub-second for a tiny local repo, or a clear spinner.',
        actual: `Took ${ms}ms from submit to the project card showing.`,
        evidence: 'reports/screens/P03-project-registered.png',
      })
    }
  } catch (e) {
    add({
      title: 'Could not register the local fixture project',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Projects / Register modal',
      repro: `Open Register modal, name="${FIXTURE_NAME}", path="${fixturePath}", submit.`,
      expected: 'Project registers and shows as a card; enables @autocomplete + dispatch.',
      actual: String(e).slice(0, 600),
      evidence: 'register flow threw — downstream dispatch tests degrade to findings',
    })
  }
})

// ---------------------------------------------------------------------------
// 3. @project autocomplete inside ⌘K.
// ---------------------------------------------------------------------------
test('@ autocomplete suggests the registered project', async ({ page }) => {
  await gotoApp(page, '#/home')
  await openCommandBar(page)
  const input = await commandInput(page)
  try {
    // Bare "@" should list projects (completion mode with empty prefix lists all).
    await input.fill('@')
    const suggestion = page.getByRole('button', { name: new RegExp(FIXTURE_NAME, 'i') })
    await expect(suggestion.first()).toBeVisible({ timeout: 6000 })
    await shot(page, 'P03-at-autocomplete')

    // Type a prefix and confirm it narrows to the fixture.
    await input.fill(`@${FIXTURE_NAME.slice(0, 4)}`)
    await expect(
      page.getByRole('button', { name: new RegExp(FIXTURE_NAME, 'i') }).first(),
    ).toBeVisible({ timeout: 6000 })
  } catch (e) {
    add({
      title: '@project autocomplete did not surface the registered project',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K / @autocomplete',
      repro: 'Open ⌘K, type "@" then a name prefix.',
      expected: 'A completion row for the registered project appears.',
      actual: String(e).slice(0, 500),
      evidence: 'reports/screens/P03-at-autocomplete.png',
    })
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. Dispatch "confirm card" preview — for a plain prompt AND a @project prompt.
//    CRITICAL CHARTER CHECK: the charter expects a confirm card that previews
//    project / model / scope before firing. Assert whether one actually exists.
// ---------------------------------------------------------------------------
test('dispatch shows a confirm/preview before firing (plain + @project)', async ({ page }) => {
  await gotoApp(page, '#/home')

  // --- Plain prompt ---
  await openCommandBar(page)
  let input = await commandInput(page)
  await input.fill('list the files in this repo')
  const plainDispatchRow = page.getByRole('button', { name: /Dispatch agent:/i })
  await expect(plainDispatchRow.first()).toBeVisible({ timeout: 6000 })
  await shot(page, 'P03-dispatch-plain-preview')

  // Does the preview disclose model and scope/permission-mode? The bar only
  // shows the prompt text — no model, no scope, no plan-mode badge.
  const barText = (await page.locator('.glass').first().innerText().catch(() => '')) || ''
  const showsModel = /model|opus|sonnet|haiku|claude-/i.test(barText)
  const showsScope = /plan mode|scope|permission|read.?only|cwd/i.test(barText)
  if (!showsModel || !showsScope) {
    add({
      title: 'No confirm card: ⌘K dispatches immediately with no model/scope preview',
      severity: 'High',
      category: 'Missing',
      surface: '⌘K / dispatch',
      repro: 'Open ⌘K, type a prompt; inspect the highlighted "Dispatch agent" row.',
      expected:
        'Charter expects a CONFIRM CARD previewing project / model / scope (e.g. plan mode) before the run fires.',
      actual: `The palette shows only the prompt text and runs on Enter — no confirm step. modelShown=${showsModel} scopeShown=${showsScope}. Bar text: ${barText.replace(/\s+/g, ' ').slice(0, 200)}`,
      evidence: 'reports/screens/P03-dispatch-plain-preview.png; CommandBar.execute() calls api.runs.start directly',
    })
  }
  await page.keyboard.press('Escape').catch(() => {})

  // --- @project prompt ---
  await openCommandBar(page)
  input = await commandInput(page)
  await input.fill(`@${FIXTURE_NAME} list the files in this repo`)
  try {
    const projectRow = page.getByRole('button', { name: /Dispatch in/i })
    await expect(projectRow.first()).toBeVisible({ timeout: 6000 })
    // The @project row at least names the project — verify the project name shows.
    const rowText = await projectRow.first().innerText()
    await shot(page, 'P03-dispatch-project-preview')
    if (!new RegExp(FIXTURE_NAME, 'i').test(rowText)) {
      add({
        title: '@project dispatch row does not name the target project',
        severity: 'Med',
        category: 'UX',
        surface: '⌘K / @project dispatch',
        repro: `Type "@${FIXTURE_NAME} <prompt>" in ⌘K.`,
        expected: 'The dispatch row clearly names the project it will run in.',
        actual: `Row text: ${rowText.slice(0, 160)}`,
        evidence: 'reports/screens/P03-dispatch-project-preview.png',
      })
    }
  } catch (e) {
    add({
      title: '@project prompt did not produce a "Dispatch in <project>" row',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K / @project dispatch',
      repro: `Type "@${FIXTURE_NAME} <prompt>" in ⌘K.`,
      expected: 'A "Dispatch in <project>: <prompt>" row appears.',
      actual: String(e).slice(0, 500),
      evidence: 'reports/screens/P03-dispatch-project-preview.png',
    })
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 5. THE one real run (budget = exactly ONE). @project plan-mode dispatch,
//    then assert: navigates to the run console, live console streams events,
//    the run appears in the list, run_update fires, terminal status reached.
// ---------------------------------------------------------------------------
test('REAL RUN: one plan-mode dispatch streams to a terminal status', async ({ page }) => {
  if (realRunFired) {
    test.skip(true, 'real-run budget already spent')
    return
  }
  await gotoApp(page, '#/home')
  await openCommandBar(page)
  const input = await commandInput(page)
  await input.fill(`@${FIXTURE_NAME} list the files in this repo`)

  const dispatchRow = page.getByRole('button', { name: /Dispatch in/i }).first()
  try {
    await expect(dispatchRow).toBeVisible({ timeout: 6000 })
  } catch {
    add({
      title: 'REAL RUN blocked: no @project dispatch row to confirm',
      severity: 'Critical',
      category: 'Bug',
      surface: '⌘K / dispatch',
      repro: `Type "@${FIXTURE_NAME} list the files in this repo" and look for the dispatch row.`,
      expected: 'A dispatch row to click/Enter.',
      actual: 'Row never appeared; cannot fire the real run.',
      evidence: 'commandInput filled, row not visible',
    })
    await page.keyboard.press('Escape').catch(() => {})
    return
  }

  realRunFired = true
  const dispatch = await timed(async () => {
    await dispatchRow.click()
    // execute() navigates to #/runs/<id> on success.
    await page.waitForURL(/#\/runs\/.+/, { timeout: 20_000 })
  }).catch((e) => ({ ms: -1, value: null, err: e }))

  if ('err' in dispatch || dispatch.ms < 0) {
    // Dispatch failed before navigation — the bar shows "⚠ <error>" in its footer.
    const footer = await page.locator('.glass').first().innerText().catch(() => '')
    add({
      title: 'REAL RUN: dispatch failed before reaching the run console',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K / dispatch → runs',
      repro: `Confirm the "@${FIXTURE_NAME} list the files in this repo" dispatch.`,
      expected: 'Navigates to #/runs/<id> and a run starts.',
      actual: `No navigation. Command bar footer: ${footer.replace(/\s+/g, ' ').slice(0, 300)}`,
      evidence: 'waitForURL(/#/runs/) timed out',
    })
    await shot(page, 'P03-realrun-dispatch-failed')
    return
  }

  // Extract the run id from the URL.
  const url = page.url()
  realRunId = url.match(/#\/runs\/([^/?]+)/)?.[1] ?? null
  await waitForWs(page)
  await shot(page, 'P03-realrun-console')

  // (a) Live console streams *something* — events, or at minimum the run header.
  //     We watch for either real event lines or an error event from the runner.
  const consoleRegion = page.locator('section').last()
  let firstOutputMs = -1
  const t0 = Date.now()
  try {
    // "Waiting for output…" is the empty state; wait for it to be replaced OR
    // for any error/usage/status glyph to appear.
    await expect
      .poll(
        async () => {
          const txt = await consoleRegion.innerText().catch(() => '')
          // Any of these means the stream produced output.
          return /⚠|▸|──|⚙|\$\d|tok/i.test(txt) || (!/Waiting for output/i.test(txt) && txt.trim().length > 40)
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy()
    firstOutputMs = Date.now() - t0
  } catch {
    add({
      title: 'REAL RUN: live console produced no streamed output within 30s',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole live stream',
      repro: 'Dispatch a plan-mode run and watch the console pane.',
      expected: 'Events stream in within a few seconds (assistant/usage/status/error).',
      actual: 'Console stayed on "Waiting for output…" for 30s.',
      evidence: 'reports/screens/P03-realrun-console.png',
    })
  }
  if (firstOutputMs > 8000) {
    add({
      title: 'REAL RUN: first streamed output is slow',
      severity: 'Med',
      category: 'Perf',
      surface: 'RunConsole live stream',
      repro: 'Dispatch a plan-mode run, time until first console output.',
      expected: 'First token/event within a few seconds.',
      actual: `First output after ${firstOutputMs}ms.`,
      evidence: 'expect.poll timing',
    })
  }

  // (b) Reach a terminal status. The header status badge transitions to one of
  //     done/error/killed/interrupted. (run_update is what drives this badge —
  //     observing the badge change proves run_update arrived over the WS.)
  const TERMINALS = ['done', 'error', 'killed', 'interrupted']
  let terminal: string | null = null
  try {
    await expect
      .poll(
        async () => {
          const header = await page.locator('section').last().innerText().catch(() => '')
          terminal = TERMINALS.find((s) => new RegExp(`\\b${s}\\b`).test(header)) ?? null
          return terminal
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] },
      )
      .not.toBeNull()
  } catch {
    /* handled below */
  }
  realRunTerminalStatus = terminal
  await shot(page, 'P03-realrun-terminal')

  if (!terminal) {
    add({
      title: 'REAL RUN: run never reached a terminal status within 60s',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole / run_update',
      repro: 'Dispatch a plan-mode run; wait for the status badge to settle.',
      expected: 'Run reaches done/error/killed/interrupted; run_update drives the badge.',
      actual: 'Status badge never reached a terminal state.',
      evidence: 'reports/screens/P03-realrun-terminal.png',
    })
  } else if (terminal === 'error') {
    // High-value finding per charter: capture the exact error text the UI shows.
    const consoleText = await page.locator('section').last().innerText().catch(() => '')
    const errLine = consoleText.split('\n').find((l) => l.includes('⚠')) ?? consoleText.slice(0, 400)
    add({
      title: 'REAL RUN reached terminal status "error" (claude CLI / runner failure)',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole / supervisor + claude CLI',
      repro: `Dispatch "@${FIXTURE_NAME} list the files in this repo" in plan mode.`,
      expected: 'A plan-mode run completes "done" listing repo files.',
      actual: `Run ended "error". Console error line: ${errLine.replace(/\s+/g, ' ').slice(0, 400)}`,
      evidence: 'reports/screens/P03-realrun-terminal.png; this is the claude-CLI-status finding',
    })
  }

  // (c) The run appears in the run list with a matching prompt.
  await gotoApp(page, '#/runs')
  try {
    await expect(page.getByText('list the files in this repo').first()).toBeVisible({ timeout: 8000 })
    await shot(page, 'P03-realrun-in-list')
  } catch {
    add({
      title: 'REAL RUN does not appear in the run list',
      severity: 'High',
      category: 'Bug',
      surface: 'RunList',
      repro: 'After dispatching, open #/runs.',
      expected: 'The new run is listed with its prompt.',
      actual: 'Prompt not found in the run list.',
      evidence: 'reports/screens/P03-realrun-in-list.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 6. Run-list filters + selecting a past run.
// ---------------------------------------------------------------------------
test('run list filters and past-run selection work', async ({ page }) => {
  await gotoApp(page, '#/runs')
  try {
    // Filter chips render as "all N", "active N", etc.
    for (const f of ['all', 'active', 'done', 'error']) {
      const chip = page.getByRole('button', { name: new RegExp(`^${f}\\b`, 'i') })
      await expect(chip.first()).toBeVisible({ timeout: 6000 })
    }
    // Click "done" then "all" — must not crash, list re-renders.
    await page.getByRole('button', { name: /^done\b/i }).first().click()
    await shot(page, 'P03-filter-done')
    await page.getByRole('button', { name: /^all\b/i }).first().click()

    // Select a past run by clicking the first row, assert the console opens.
    const firstRow = page.locator('[role="button"]').filter({ hasText: /tok|repo|files|·/ }).first()
    // Fallback: any run row carries a status word + prompt; click the prompt text.
    const promptRow = page.getByText('list the files in this repo').first()
    const target = (await promptRow.isVisible().catch(() => false)) ? promptRow : firstRow
    if (await target.isVisible().catch(() => false)) {
      await target.click()
      await page.waitForURL(/#\/runs\/.+/, { timeout: 8000 })
      await shot(page, 'P03-past-run-selected')
    } else {
      add({
        title: 'No selectable past run row found in the run list',
        severity: 'Low',
        category: 'UX',
        surface: 'RunList',
        repro: 'Open #/runs and try to click a run row.',
        expected: 'At least the just-dispatched run is selectable.',
        actual: 'No clickable run row located.',
        evidence: 'reports/screens/P03-filter-done.png',
      })
    }
  } catch (e) {
    add({
      title: 'Run-list filters / selection interaction failed',
      severity: 'Med',
      category: 'Bug',
      surface: 'RunList',
      repro: 'Open #/runs, click filter chips, click a run row.',
      expected: 'Filters toggle and a row selects without error.',
      actual: String(e).slice(0, 500),
      evidence: 'reports/screens/P03-filter-done.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 7. Kill affordance — only exercise if a run is still in-flight (don't burn a
//    second real run just to kill). Otherwise record presence/absence.
// ---------------------------------------------------------------------------
test('kill affordance present for in-flight runs (no extra real run spent)', async ({ page }) => {
  await gotoApp(page, '#/runs')
  try {
    // Filter to active; if the real run is still running, a Kill control exists.
    await page.getByRole('button', { name: /^active\b/i }).first().click()
    const killBtn = page.getByRole('button', { name: /Kill run/i }).first()
    const activeKillVisible = await killBtn.isVisible().catch(() => false)
    if (activeKillVisible) {
      const { ms } = await timed(async () => {
        await killBtn.click()
        // After kill, status should move to "killed" (run_update).
        await expect(page.getByText(/killed/i).first()).toBeVisible({ timeout: 15_000 })
      })
      await shot(page, 'P03-killed')
      if (ms > 5000) {
        add({
          title: 'Kill takes a while to reflect in the UI',
          severity: 'Low',
          category: 'Perf',
          surface: 'RunList / kill',
          repro: 'Kill an in-flight run; time until status shows "killed".',
          expected: 'Near-immediate "killed" via run_update.',
          actual: `Took ${ms}ms.`,
          evidence: 'reports/screens/P03-killed.png',
        })
      }
    } else {
      // No in-flight run (the real run already terminated). Verify the kill
      // affordance is at least *defined* by checking a terminal run has none.
      await shot(page, 'P03-no-active-run')
      add({
        title: 'Kill affordance not exercised — no in-flight run available',
        severity: 'Nit',
        category: 'UX',
        surface: 'RunList / kill',
        repro: 'Filter Runs by "active" after the plan-mode run already finished.',
        expected: 'A Kill control would show only while a run is running/queued (by design).',
        actual: `Real run terminal status was "${realRunTerminalStatus ?? 'unknown'}", so no kill button to click. Affordance presence verified only in code (group-hover ✕ + console "Kill").`,
        evidence: 'reports/screens/P03-no-active-run.png',
      })
    }
  } catch (e) {
    add({
      title: 'Kill affordance check failed',
      severity: 'Med',
      category: 'Bug',
      surface: 'RunList / kill',
      repro: 'Filter active runs and look for a Kill control.',
      expected: 'Kill control present for running/queued runs.',
      actual: String(e).slice(0, 400),
      evidence: 'kill flow threw',
    })
  }
})

// ---------------------------------------------------------------------------
// 8. "Create PR from Run" → graceful failure at the local-only boundary.
//    Path: RunConsole footer button → project prs-ci tab → "+ Open PR" modal →
//    submit → api.projects.createPr should FAIL CLEARLY (no GitHub remote),
//    not crash or silently no-op.
// ---------------------------------------------------------------------------
test('Create PR from Run fails gracefully with no GitHub remote', async ({ page }) => {
  if (!realRunId) {
    add({
      title: 'Create-PR boundary not testable — no real run id captured',
      severity: 'Low',
      category: 'Missing',
      surface: 'RunConsole / Create PR',
      repro: 'Requires a completed project-scoped run to open its console footer.',
      expected: 'A terminal project-scoped run shows "Create PR from Run".',
      actual: 'No run id was captured from the real-run step.',
      evidence: 'realRunId is null',
    })
    return
  }

  // Resilient nav: the dev stack can restart under sustained E2E load (it
  // recompiles the bible/ui-artifact on boot), briefly dropping the WS. Don't
  // let a transient WS hiccup abort the run before findings are written.
  try {
    await gotoApp(page, `#/runs/${realRunId}`)
  } catch (navErr) {
    add({
      title: 'Dev stack WS dropped mid-session (stack instability under E2E load)',
      severity: 'Med',
      category: 'Bug',
      surface: 'Core/Web dev server + WS',
      repro: 'Run the full P03 suite; during a later navigation the WS dot fails to go green within 30s.',
      expected: 'The stack stays up for the whole session; WS reconnects promptly.',
      actual: `gotoApp(#/runs/${realRunId}) never reached WS-connected: ${String(navErr).slice(0, 200)}`,
      evidence: 'waitForWs timeout; core logs show a bible/ui-artifact recompile (server reboot)',
    })
    // Best-effort: continue without the WS gate so we can still test the boundary.
    await page.goto(`/#/runs/${realRunId}`).catch(() => {})
  }
  try {
    // The footer button only renders for terminal + project-scoped runs.
    const createPr = page.getByRole('button', { name: /Create PR from Run/i })
    const hasButton = await createPr.isVisible().catch(() => false)
    if (!hasButton) {
      add({
        title: '"Create PR from Run" affordance missing on a terminal project run',
        severity: 'Med',
        category: 'Missing',
        surface: 'RunConsole footer',
        repro: 'Open a completed @project run console.',
        expected: 'A "Create PR from Run →" button is shown for terminal project-scoped runs.',
        actual: `Button not visible (run status="${realRunTerminalStatus ?? 'unknown'}", run was project-scoped).`,
        evidence: 'reports/screens/P03-realrun-terminal.png',
      })
      return
    }
    await shot(page, 'P03-createpr-button')
    // It navigates to the project PRs & CI tab (it does NOT open a PR directly).
    await createPr.click()
    await page.waitForURL(/#\/project\/.+\/prs-ci/, { timeout: 8000 })
    await waitForWs(page)
    await shot(page, 'P03-prsci-tab')

    // Open the actual PR modal and submit against a repo with no remote.
    await page.getByRole('button', { name: /Open PR/i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 6000 })
    await dialog.getByPlaceholder(/feat: my change/i).fill('test: from P03')
    await dialog.getByPlaceholder(/feat\/my-branch/i).fill('feat/p03')
    // base defaults to "main"; submit. Expect a visible inline error (red
    // text) in the modal, not a crash / silent success.
    let sawError = false
    let submitMs = -1
    const redText = dialog.locator('.text-\\[var\\(--red\\)\\]').first()
    try {
      const t = Date.now()
      await dialog.getByRole('button', { name: /^Create PR$/i }).click()
      await expect(redText).toBeVisible({ timeout: 25_000 })
      sawError = true
      submitMs = Date.now() - t
    } catch {
      sawError = false
    }

    if (!sawError) {
      // No error surfaced — check whether it silently succeeded/no-oped or hung.
      const modalStillOpen = await dialog.isVisible().catch(() => false)
      add({
        title: 'Create PR with no remote did NOT surface a clear error',
        severity: 'High',
        category: 'Bug',
        surface: 'PrsCiTab / createPr',
        repro: 'On a repo with no GitHub remote, open the PR modal and submit.',
        expected: 'A clear inline error (no remote / gh failure); no silent success, no hang.',
        actual: modalStillOpen
          ? 'No inline error appeared within 25s; modal still open (possible hang / swallowed error).'
          : 'Modal closed with no error — possible silent no-op / false success.',
        evidence: 'reports/screens/P03-prsci-tab.png',
      })
    } else {
      void submitMs
      const errText = await dialog.locator('.text-\\[var\\(--red\\)\\]').first().innerText().catch(() => '')
      await shot(page, 'P03-createpr-error')
      // Good: it failed gracefully. Record as a low-sev confirmation only if the
      // message is unhelpful.
      if (!errText.trim() || /\[object|undefined|500\b/i.test(errText)) {
        add({
          title: 'Create-PR error message is unclear / leaks internals',
          severity: 'Med',
          category: 'UX',
          surface: 'PrsCiTab / createPr',
          repro: 'Submit the PR modal on a repo with no remote.',
          expected: 'A human-readable explanation (e.g. "no GitHub remote configured").',
          actual: `Error shown: "${errText.replace(/\s+/g, ' ').slice(0, 200)}"`,
          evidence: 'reports/screens/P03-createpr-error.png',
        })
      }
    }
  } catch (e) {
    add({
      title: 'Create-PR-from-Run flow threw before reaching the failure boundary',
      severity: 'Med',
      category: 'Bug',
      surface: 'RunConsole → PrsCiTab',
      repro: 'Open a terminal project run console; click "Create PR from Run"; submit modal.',
      expected: 'Reach the PR modal and observe a graceful failure.',
      actual: String(e).slice(0, 500),
      evidence: 'reports/screens/P03-prsci-tab.png',
    })
  }
})

// ---------------------------------------------------------------------------
// Fail-loud: console/page errors during this persona's flow are findings.
// ---------------------------------------------------------------------------
test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    add({
      title: 'Uncaught page error during dispatch flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Dispatch / runs',
      repro: 'Drive the dispatch flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
    sink.pageErrors = []
  }
  if (sink?.errors.length) {
    // Filter pure network-noise lines that are expected (e.g. createPr 4xx/5xx
    // we intentionally provoke) so we don't double-count the graceful-failure.
    const meaningful = sink.errors.filter(
      (e) => !/Failed to load resource|\/api\/projects\/.+\/prs/i.test(e),
    )
    if (meaningful.length) {
      add({
        title: 'console.error logged during dispatch flow',
        severity: 'High',
        category: 'Bug',
        surface: 'Dispatch / runs',
        repro: 'Drive the dispatch flow with the console attached.',
        expected: 'No unexpected console.error in a clean session.',
        actual: meaningful.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
    sink.errors = []
  }
})

test.afterAll(() => {
  // Resilient: never let report-writing be skipped.
  try {
    add({
      title: 'Real-run loop summary (informational)',
      severity: 'Nit',
      category: 'Bug',
      surface: 'RunConsole end-to-end',
      repro: `One plan-mode dispatch: "@${FIXTURE_NAME} list the files in this repo".`,
      expected: 'End-to-end: dispatch → stream → run_update → terminal status.',
      actual: `realRunFired=${realRunFired}, runId=${realRunId ?? 'none'}, terminalStatus=${realRunTerminalStatus ?? 'none'}.`,
      evidence: 'aggregated from the REAL RUN test',
    })
  } catch {
    /* ignore */
  }
  try {
    writeFindings('P03', CHARTER, findings)
  } catch (e) {
    // Last-ditch: at least surface that report writing failed.
    // eslint-disable-next-line no-console
    console.error('writeFindings failed:', e)
  }
})

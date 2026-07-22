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
// P09 — Resilience / Edge Cases
// Charter: break things and record how gracefully the app degrades.
//   • Register form abuse (empty / spaces-only / both-fields / malformed URL /
//     special chars / huge name) → clear validation, no crash, no stuck modal.
//     Modal dismiss via backdrop + Escape.
//   • ⌘K abuse: empty prompt, huge multi-KB prompt, special chars/emoji/quotes,
//     rapid double-submit.
//   • WS resilience: client auto-reconnects in 3s on drop — observe the status
//     dot transition (close the socket via page.evaluate).
//   • REAL RUN (budget = exactly ONE): dispatch one tiny plan-mode run, then KILL
//     it and assert the UI reflects the killed/terminal state.
//   • Concurrent actions: rapid double dispatch / nav → note state corruption.
//
// Resilient: every exploratory interaction is wrapped so one broken surface can
// never abort the run before writeFindings. Only the stack reachability (WS) is
// hard-asserted. Modeled on P01/P04.
// ===========================================================================

const CHARTER =
  'Resilience / edge cases: register-form abuse + modal dismiss, ⌘K abuse (empty/huge/special/double-submit), WS auto-reconnect, ONE real kill-flow dispatch, concurrent actions.'
const findings: Finding[] = []
let sink: ConsoleSink

// Spend the single real-dispatch budget exactly once across the whole run.
let realDispatchSpent = false

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// A screenshot that never throws — a crashed/closed page must not abort the run
// before writeFindings (RUNBOOK resilient-spec rule).
async function safeShot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* page/context closed — ignore */
  }
}

// --- Register modal helpers --------------------------------------------------

async function openRegisterModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: /register project/i }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

/** Did the Register button stay disabled (the app's only validation gate)? */
async function registerDisabled(page: Page): Promise<boolean> {
  const btn = page.getByRole('dialog').getByRole('button', { name: /Register/i })
  return btn.isDisabled().catch(() => false)
}

// ===========================================================================
// 1. REGISTER FORM ABUSE
// ===========================================================================

test('register modal: empty + whitespace-only inputs stay gated (no submit, no crash)', async ({ page }) => {
  await gotoApp(page, '#/projects')
  try {
    await openRegisterModal(page)
    const dialog = page.getByRole('dialog')
    const inputs = dialog.locator('input')

    // (a) Both empty → Register must be disabled.
    if (!(await registerDisabled(page))) {
      findings.push({
        title: 'Register button is enabled with both fields empty',
        severity: 'High',
        category: 'Bug',
        surface: 'ProjectsPage / Register modal',
        repro: 'Projects → + register project → leave name + source empty.',
        expected: 'Register stays disabled until both fields are non-empty.',
        actual: 'Register button was enabled with empty inputs.',
        evidence: 'reports/screens/P09-register-empty.png',
      })
    }
    await safeShot(page, 'P09-register-empty')

    // (b) Whitespace-only → the UI trims, so this must still be gated.
    await inputs.nth(0).fill('   ')
    await inputs.nth(1).fill('   ')
    if (!(await registerDisabled(page))) {
      findings.push({
        title: 'Register accepts whitespace-only name/source',
        severity: 'Med',
        category: 'Bug',
        surface: 'ProjectsPage / Register modal',
        repro: 'Register modal → type only spaces into both fields.',
        expected: 'name.trim()/source.trim() are empty → Register stays disabled.',
        actual: 'Register button was enabled for whitespace-only inputs.',
        evidence: 'reports/screens/P09-register-whitespace.png',
      })
    }
    await safeShot(page, 'P09-register-whitespace')

    // (c) name present but source whitespace-only → still gated.
    await inputs.nth(0).fill('valid-name')
    await inputs.nth(1).fill('   ')
    if (!(await registerDisabled(page))) {
      findings.push({
        title: 'Register accepts a whitespace-only source path',
        severity: 'Med',
        category: 'Bug',
        surface: 'ProjectsPage / Register modal',
        repro: 'Register modal → name filled, source = spaces only.',
        expected: 'Trimmed source empty → Register disabled.',
        actual: 'Register was enabled with a whitespace-only source.',
        evidence: 'reports/screens/P09-register-whitespace.png',
      })
    }

    // Close for the next test.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5_000 })
  } catch (e) {
    findings.push({
      title: 'Register empty/whitespace validation flow threw',
      severity: 'Med',
      category: 'Bug',
      surface: 'ProjectsPage / Register modal',
      repro: 'Open Register modal and exercise empty/whitespace inputs.',
      expected: 'Flow completes; button gating observable.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-register-empty.png',
    })
  }
})

test('register modal: malformed URL / special chars / huge name → graceful server error, no crash, no stuck modal', async ({ page }) => {
  await gotoApp(page, '#/projects')

  // Each case: fill, submit, and assert the modal neither crashes nor sticks
  // silently. A malformed/garbage source should yield a visible ⚠ error message
  // (register.isError) and leave the modal open & dismissable — NOT register a
  // broken project, hang, or throw.
  const cases: Array<{ id: string; name: string; source: string; note: string }> = [
    { id: 'badurl', name: 'P09-badurl', source: 'http:/not a url\\::', note: 'malformed github URL' },
    { id: 'special', name: 'P09-spëcial!@#$%^&*()', source: 'C:\\nope\\<>|?*"', note: 'special chars in name + bad path' },
    { id: 'huge', name: 'L'.repeat(5000), source: 'C:\\also\\missing', note: 'extremely long (5KB) name' },
  ]

  for (const c of cases) {
    try {
      await openRegisterModal(page)
      const dialog = page.getByRole('dialog')
      const inputs = dialog.locator('input')
      await inputs.nth(0).fill(c.name)
      await inputs.nth(1).fill(c.source)

      const submit = dialog.getByRole('button', { name: /Register/i })
      // With both fields non-empty the button should enable; click it.
      await submit.click({ timeout: 5_000 }).catch(() => {})

      // The mutation should resolve to an ERROR (these paths/URLs don't exist),
      // surfaced inline as "⚠ …". Poll the modal: it must stay open with an
      // error rather than silently closing as if it succeeded.
      let outcome: 'error-shown' | 'closed' | 'stuck-pending' = 'stuck-pending'
      await expect
        .poll(
          async () => {
            const errShown = await dialog.getByText(/^⚠/).first().isVisible().catch(() => false)
            if (errShown) { outcome = 'error-shown'; return true }
            const stillOpen = await dialog.isVisible().catch(() => false)
            if (!stillOpen) { outcome = 'closed'; return true }
            return false
          },
          { timeout: 20_000 },
        )
        .toBe(true)
        .catch(() => {})

      await safeShot(page, `P09-register-${c.id}`)

      if (outcome === 'closed') {
        // Modal closed == the app treated this garbage as a successful register.
        findings.push({
          title: `Register accepted invalid input as success (${c.note})`,
          severity: 'High',
          category: 'Bug',
          surface: 'ProjectsPage / Register modal',
          repro: `Register modal → name="${c.name.slice(0, 24)}…" source="${c.source}" → Register.`,
          expected: 'A non-existent path / malformed URL is rejected with a clear inline error; modal stays open.',
          actual: 'Modal closed as if the register succeeded — no validation error shown.',
          evidence: `reports/screens/P09-register-${c.id}.png`,
        })
      } else if (outcome === 'stuck-pending') {
        findings.push({
          title: `Register hangs (no error, no close) on invalid input (${c.note})`,
          severity: 'High',
          category: 'Bug',
          surface: 'ProjectsPage / Register modal',
          repro: `Register modal → invalid ${c.note} → Register; wait 20s.`,
          expected: 'Resolves to a clear error or success within a few seconds.',
          actual: 'Modal stayed open with no inline error and no close — appears stuck/pending.',
          evidence: `reports/screens/P09-register-${c.id}.png`,
        })
      }
      // outcome === 'error-shown' is the graceful, expected path → no finding.

      // Clean up: dismiss before the next case.
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    } catch (e) {
      findings.push({
        title: `Register abuse case "${c.id}" crashed the flow`,
        severity: 'Med',
        category: 'Bug',
        surface: 'ProjectsPage / Register modal',
        repro: `Register modal → ${c.note}.`,
        expected: 'Graceful inline error; flow continues.',
        actual: String(e).slice(0, 300),
        evidence: `reports/screens/P09-register-${c.id}.png`,
      })
      await page.keyboard.press('Escape').catch(() => {})
    }
  }

  // UX observation: the modal has ONE source field that auto-detects URL vs path
  // (isUrl = /^(https:\/\/|git@)/). There is no way to supply BOTH a local path
  // AND a github url, and no inline format validation before the network call.
  findings.push({
    title: 'Register modal has no client-side path/URL validation before submit',
    severity: 'Low',
    category: 'UX',
    surface: 'ProjectsPage / Register modal',
    repro: 'Type a clearly malformed path or URL into the single source field.',
    expected: 'Inline format hint (valid path vs URL) before spending a round-trip; the field cannot express "both path AND url" — it auto-detects one.',
    actual: 'The only gate is non-empty trimmed name+source; any malformed string is sent to core and only fails server-side. "Both fields" is not expressible (single auto-detected source input).',
    evidence: 'web/src/pages/ProjectsPage.tsx (isUrl ternary, disabled gate).',
  })
})

test('register modal: dismiss via backdrop click and via Escape', async ({ page }) => {
  await gotoApp(page, '#/projects')

  // (a) Escape closes.
  try {
    await openRegisterModal(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 })
  } catch (e) {
    findings.push({
      title: 'Register modal does not close on Escape',
      severity: 'Med',
      category: 'UX',
      surface: 'ProjectsPage / Register modal',
      repro: 'Open Register modal → press Escape.',
      expected: 'Modal closes (window-level Escape handler).',
      actual: String(e).slice(0, 200),
      evidence: 'reports/screens/P09-register-dismiss.png',
    })
  }

  // (b) Backdrop click closes. The backdrop is the absolute inset-0 overlay
  // behind the dialog card; click near a corner to avoid hitting the card.
  try {
    await openRegisterModal(page)
    await page.mouse.click(8, 8) // top-left corner → backdrop, not the centered card
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 })
  } catch (e) {
    findings.push({
      title: 'Register modal does not close on backdrop click',
      severity: 'Low',
      category: 'UX',
      surface: 'ProjectsPage / Register modal',
      repro: 'Open Register modal → click the dimmed backdrop outside the card.',
      expected: 'Backdrop onClick closes the modal.',
      actual: String(e).slice(0, 200),
      evidence: 'reports/screens/P09-register-dismiss.png',
    })
  }
  await safeShot(page, 'P09-register-dismiss')
})

// ===========================================================================
// 2. ⌘K COMMAND BAR ABUSE
// ===========================================================================

test('command bar: empty prompt is not dispatchable; special/emoji/quotes preview as a dispatch', async ({ page }) => {
  test.skip(true, 'CommandBar retired at UI Simplification Task 18 (2026-07) — the mixed nav+dispatch ambiguity list (empty-query dispatch gating, "Dispatch agent:" preview rows) has no MessageDock equivalent: free text always sends as a chat message, and dispatch is @project-only via a separate compose card.')
  await gotoApp(page, '#/home')
  try {
    await openCommandBar(page)
    const input = page.getByPlaceholder(/Ask K/i)
    await expect(input).toBeVisible()

    // (a) Empty query → there must be NO "Dispatch agent" item (only navs).
    const emptyDispatch = await page
      .getByText(/Dispatch agent:/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (emptyDispatch) {
      findings.push({
        title: 'Command bar offers a dispatch for an empty prompt',
        severity: 'Med',
        category: 'Bug',
        surface: 'CommandBar / ⌘K',
        repro: 'Open ⌘K, type nothing, look at the list.',
        expected: 'No dispatch item until the query is non-empty (query.trim()).',
        actual: 'A "Dispatch agent" row was offered with an empty query.',
        evidence: 'reports/screens/P09-cmdk-empty.png',
      })
    }
    // Pressing Enter on an empty query is NOT a dispatch — but the list defaults
    // to selecting the first item, which (empty query) is a nav (Home). So Enter
    // navigates + closes the palette rather than dispatching an empty prompt.
    // That's acceptable (no empty dispatch), but record the behavior.
    await input.press('Enter')
    await page.waitForTimeout(300)
    const barClosedAfterEmptyEnter = await input.isHidden().catch(() => true)
    await safeShot(page, 'P09-cmdk-empty')
    if (barClosedAfterEmptyEnter) {
      findings.push({
        title: 'Enter on an empty ⌘K query silently navigates instead of doing nothing',
        severity: 'Low',
        category: 'UX',
        surface: 'CommandBar / ⌘K',
        repro: 'Open ⌘K, type nothing, press Enter.',
        expected: 'A no-op (or an explicit hint), since there is no prompt to dispatch.',
        actual: 'The first nav item is auto-selected, so Enter navigates away and closes the palette. No empty dispatch is fired (good), but the jump is unexpected.',
        evidence: 'reports/screens/P09-cmdk-empty.png',
      })
    }

    // (b) Special chars / emoji / quotes preview correctly (no crash, escaped).
    // Re-open the palette in case the empty-Enter above navigated/closed it.
    if (await input.isHidden().catch(() => true)) {
      await openCommandBar(page)
    }
    const input2 = page.getByPlaceholder(/Ask K/i)
    await expect(input2).toBeVisible({ timeout: 5_000 })
    const nasty = `dispatch "weird" <tag> & 'quote' 🚀🔥 \`tick\` \\back/slash`
    await input2.fill(nasty)
    const dispatchRow = page.getByText(/Dispatch agent:/i).first()
    await expect(dispatchRow).toBeVisible({ timeout: 5_000 })
    await safeShot(page, 'P09-cmdk-special')

    await page.keyboard.press('Escape')
    await expect(input).toBeHidden({ timeout: 5_000 })
  } catch (e) {
    findings.push({
      title: 'Command bar empty/special-char handling threw',
      severity: 'Med',
      category: 'Bug',
      surface: 'CommandBar / ⌘K',
      repro: 'Open ⌘K; submit empty; type special chars + emoji.',
      expected: 'No crash; dispatch preview renders escaped text.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-cmdk-special.png',
    })
  }
})

test('command bar: a huge multi-KB prompt does not freeze or crash the palette', async ({ page }) => {
  test.skip(true, 'CommandBar retired at UI Simplification Task 18 (2026-07) — this asserts the "Dispatch agent:" preview renders for free text; the MessageDock never previews a dispatch for plain text (dispatch is @project-only via a separate compose card), so there is nothing equivalent left to time.')
  await gotoApp(page, '#/home')
  try {
    await openCommandBar(page)
    const input = page.getByPlaceholder(/Ask K/i)
    const huge = 'spec '.repeat(2000) // ~10 KB

    const { ms } = await timed(async () => {
      await input.fill(huge)
      // The dispatch preview should still render (the bar truncates with CSS,
      // not by refusing the input).
      await expect(page.getByText(/Dispatch agent:/i).first()).toBeVisible({ timeout: 10_000 })
    })
    await safeShot(page, 'P09-cmdk-huge')

    if (ms > 2000) {
      findings.push({
        title: 'Command bar is sluggish with a multi-KB prompt',
        severity: ms > 5000 ? 'Med' : 'Low',
        category: 'Perf',
        surface: 'CommandBar / ⌘K',
        repro: 'Open ⌘K, paste ~10 KB of text.',
        expected: 'Palette stays responsive (<2s to update the preview).',
        actual: `Took ${ms}ms to render the dispatch preview for a ~10KB query.`,
        evidence: 'reports/screens/P09-cmdk-huge.png; harness.timed().',
      })
    }
    await page.keyboard.press('Escape')
  } catch (e) {
    findings.push({
      title: 'Command bar froze/crashed on a huge prompt',
      severity: 'High',
      category: 'Bug',
      surface: 'CommandBar / ⌘K',
      repro: 'Open ⌘K, paste ~10 KB of text.',
      expected: 'No freeze/crash.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-cmdk-huge.png',
    })
  }
})

// ===========================================================================
// 3. WS RESILIENCE — auto-reconnect in 3s
// ===========================================================================

test('WS auto-reconnects within ~3s after the socket is force-closed', async ({ page }) => {
  await gotoApp(page, '#/home')
  try {
    // Confirm green first.
    await expect(page.locator('[title="core connected"]')).toBeVisible()

    // Force-close the live socket from the page. ws.ts holds the socket in a
    // module-private var, so we can't reach it directly; instead, patch the
    // global WebSocket to track instances would require pre-injection. Simplest
    // robust trigger: monkeypatch isn't available post-load, so we close via the
    // browser's network — toggle offline to drop the socket, then back online.
    await page.context().setOffline(true)

    // The dot should leave the "core connected" state (amber "connecting…").
    const wentAmber = await page
      .locator('[title="connecting…"]')
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    await safeShot(page, 'P09-ws-disconnected')

    // Restore connectivity; the 3s reconnect timer should bring the dot green.
    await page.context().setOffline(false)
    const { ms } = await timed(async () => {
      await expect(page.locator('[title="core connected"]')).toBeVisible({ timeout: 20_000 })
    })
    await safeShot(page, 'P09-ws-reconnected')

    if (!wentAmber) {
      findings.push({
        title: 'WS status dot does not visibly reflect a dropped connection',
        severity: 'Med',
        category: 'UX',
        surface: 'TopBar / WS status dot',
        repro: 'Home (green) → drop network → watch the status dot.',
        expected: 'Dot flips to amber "connecting…" while the socket is down (ws.ts emitStatus(false)).',
        actual: 'Never observed the amber "connecting…" title during the outage — drop is invisible to the operator.',
        evidence: 'reports/screens/P09-ws-disconnected.png',
      })
    }
    // Reconnect is on a 3s timer; allow generous slack for offline→online + open.
    if (ms > 12000) {
      findings.push({
        title: 'WS reconnect is slow after connectivity returns',
        severity: 'Low',
        category: 'Perf',
        surface: 'TopBar / WS reconnect',
        repro: 'Drop then restore network; time until the dot is green again.',
        expected: 'Reconnects within a few seconds (ws.ts schedules a 3s retry).',
        actual: `Took ${ms}ms after restoring connectivity to return to "core connected".`,
        evidence: 'reports/screens/P09-ws-reconnected.png; harness.timed().',
      })
    }
  } catch (e) {
    // Make sure we don't leave the context offline for later tests.
    await page.context().setOffline(false).catch(() => {})
    findings.push({
      title: 'WS reconnect test failed to return to a connected state',
      severity: 'High',
      category: 'Bug',
      surface: 'TopBar / WS reconnect',
      repro: 'Drop network on Home, restore it, wait for the dot to go green.',
      expected: 'Dot returns to "core connected" within the reconnect window.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-ws-reconnected.png',
    })
  } finally {
    await page.context().setOffline(false).catch(() => {})
  }
})

// ===========================================================================
// 4. REAL RUN — dispatch ONE tiny plan-mode run, then KILL it
// ===========================================================================

test('kill flow: dispatch one tiny run and assert the UI reaches a terminal state', async ({ page }) => {
  if (realDispatchSpent) test.skip(true, 'real-dispatch budget already spent')

  // A throwaway local repo to scope the run (cwd/projectId), per charter.
  const repo = makeScratchRepo('P09', 'edge-a')
  await gotoApp(page, '#/projects')

  // Register the fixture so the dispatch has a real project context.
  try {
    await openRegisterModal(page)
    const dialog = page.getByRole('dialog')
    const inputs = dialog.locator('input')
    await inputs.nth(0).fill('P09-edge-a')
    await inputs.nth(1).fill(repo)
    await dialog.getByRole('button', { name: /Register/i }).click()
    await expect(page.getByText('P09-edge-a', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  } catch (e) {
    findings.push({
      title: 'Could not register the fixture for the kill-flow test',
      severity: 'Med',
      category: 'Bug',
      surface: 'ProjectsPage / Register modal',
      repro: 'Register P09-edge-a local fixture before the kill test.',
      expected: 'Project registers.',
      actual: String(e).slice(0, 250),
      evidence: 'reports/screens/P09-kill-register.png',
    })
  }
  await safeShot(page, 'P09-kill-register')

  // Navigate to a clean page (#/runs) so the register modal's fading overlay
  // can't intercept the dock click — a full route change unmounts it entirely.
  await gotoApp(page, '#/runs')

  // Dispatch via the Message Dock's @project flow. RUN_PERMISSION_MODE=plan
  // keeps it safe.
  realDispatchSpent = true
  try {
    await openCommandBar(page)
    const input = page.getByTestId('dock-input')
    await expect(input).toBeVisible({ timeout: 5_000 })
    // "@project" opens the project picker; the fixture's name filters it to one row.
    await input.fill('@P09-edge-a')
    const picker = page.getByTestId('dock-project-picker')
    await expect(picker).toBeVisible({ timeout: 8_000 })
    const projRow = picker.getByRole('button', { name: /P09-edge-a/i }).first()
    await expect(projRow).toBeVisible({ timeout: 8_000 })
    await projRow.click()

    // Picking the row opens the dispatch confirm/compose card — the prompt is
    // now a separate field there (the dock no longer accepts a single
    // "@project <prompt>" string like the old ⌘K did).
    const card = page.getByTestId('dock-dispatch-card')
    await expect(card).toBeVisible({ timeout: 5_000 })
    const compose = page.getByTestId('dock-dispatch-compose')
    await compose.fill('say hi and stop')
    const runBtn = page.getByTestId('dock-dispatch-run')
    await expect(runBtn).toBeEnabled({ timeout: 5_000 })
    await runBtn.click()

    // Should navigate to the run console (#/runs/<id>). We already came FROM
    // #/runs, so wait for a run ID in the hash (a UUID segment), then for the
    // RunConsole to actually render (the prompt text in its header).
    await page.waitForURL(/#\/runs\/[0-9a-f-]{8,}/i, { timeout: 20_000 }).catch(() => {})
    await waitForWs(page)
    await page
      .getByText('say hi and stop', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {})
    await safeShot(page, 'P09-kill-dispatched')

    // The Kill button only renders while status === 'running'. With plan mode (or
    // an absent `claude` CLI) the run may go terminal almost immediately, so:
    //   • if Kill is present → click it and assert status flips to a terminal
    //     state (ideally "killed"); the button must disappear.
    //   • if Kill never appears → record whether the run reached a terminal state
    //     on its own, and that the kill affordance couldn't be exercised.
    const killBtn = page.getByRole('button', { name: /^Kill$/ })
    // Scope the status pill to the RunConsole (RunsPage wraps it in <section>),
    // NOT the run-list <aside> which has its own per-run status pills.
    const statusPill = page.locator(
      'section span:text-matches("^(running|queued|done|error|killed|interrupted)$")',
    ).first()

    // The Kill button only renders while status === 'running'. Poll generously:
    // the run goes queued → running → terminal; we want to catch the running
    // window. (Plan mode can still finish fast — handled by the else branch.)
    const killVisible = await killBtn.isVisible({ timeout: 15_000 }).catch(() => false)

    if (killVisible) {
      await killBtn.click()
      // After kill, the run should reach a terminal state and the button vanish.
      const reachedTerminal = await expect
        .poll(
          async () => {
            const txt = (await statusPill.textContent().catch(() => '')) ?? ''
            return txt.trim()
          },
          { timeout: 20_000 },
        )
        .toMatch(/killed|interrupted|done|error/)
        .then(() => true)
        .catch(() => false)

      await safeShot(page, 'P09-kill-after')
      const finalStatus = (await statusPill.textContent().catch(() => ''))?.trim() ?? '(unknown)'
      const killGone = !(await killBtn.isVisible().catch(() => false))

      if (!reachedTerminal) {
        findings.push({
          title: 'Kill did not move the run to a terminal state',
          severity: 'High',
          category: 'Bug',
          surface: 'RunConsole / Kill',
          repro: 'Dispatch a run → click Kill → watch the status pill.',
          expected: 'Status flips to killed/interrupted (terminal); Kill button disappears.',
          actual: `Status stayed "${finalStatus}" after Kill; killButtonGone=${killGone}.`,
          evidence: 'reports/screens/P09-kill-after.png',
        })
      } else {
        // Killed successfully — record the observed final state + a UX note that
        // Kill has no confirm (a single click ends a run irreversibly).
        findings.push({
          title: 'Kill ends a run with no confirmation step',
          severity: 'Low',
          category: 'UX',
          surface: 'RunConsole / Kill',
          repro: 'Dispatch a run → click Kill.',
          expected: 'Optionally a confirm for an irreversible terminal action; observed final status was acceptable.',
          actual: `Kill worked: status became "${finalStatus}", button removed=${killGone}. No confirm dialog — one click terminates.`,
          evidence: 'reports/screens/P09-kill-after.png',
        })
        if (finalStatus !== 'killed') {
          findings.push({
            title: 'Killed run does not show the "killed" status',
            severity: 'Low',
            category: 'Bug',
            surface: 'RunConsole / status pill',
            repro: 'Kill a running run; read the status pill.',
            expected: 'Status "killed" (RunConsole maps it to a gray pill).',
            actual: `Pill showed "${finalStatus}" instead of "killed" (likely a race: the run completed before the kill landed).`,
            evidence: 'reports/screens/P09-kill-after.png',
          })
        }
      }
    } else {
      // Kill affordance never appeared. Determine why: terminal-already vs no CLI.
      const finalStatus = (await statusPill.textContent().catch(() => ''))?.trim() ?? '(none)'
      const errorEvent = await page
        .getByText(/⚠/)
        .first()
        .textContent()
        .catch(() => null)
      findings.push({
        title: 'Kill affordance could not be exercised — run left running state too fast (or claude CLI unavailable)',
        severity: 'Low',
        category: 'UX',
        surface: 'RunConsole / Kill',
        repro: 'Dispatch a tiny plan-mode run; look for the Kill button (only shown while status===running).',
        expected: 'A running run exposes a Kill button long enough to use it.',
        actual: `Kill button never visible within 8s. Run status pill="${finalStatus}". Error event (if any): ${String(errorEvent).slice(0, 160)}. Likely the run went terminal immediately (plan mode / missing claude CLI), so the kill UI had no window.`,
        evidence: 'reports/screens/P09-kill-dispatched.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Kill-flow dispatch crashed',
      severity: 'Med',
      category: 'Bug',
      surface: 'MessageDock→RunConsole / kill flow',
      repro: 'Dispatch a tiny run via the Message Dock (@project), then attempt Kill.',
      expected: 'Dispatch + kill flow completes without throwing.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-kill-dispatched.png',
    })
  }
})

// ===========================================================================
// 5. CONCURRENT ACTIONS — rapid double-nav, no state corruption
// ===========================================================================

test('concurrent navigation: rapid route switches do not corrupt the shell', async ({ page }) => {
  await gotoApp(page, '#/home')
  try {
    // Fire several hash navigations back-to-back without awaiting settle.
    const routes = ['#/projects', '#/runs', '#/skills', '#/metrics', '#/home', '#/runs']
    for (const r of routes) {
      await page.evaluate((hash) => { window.location.hash = hash }, r)
    }
    // Land somewhere coherent and keep WS.
    await page.waitForTimeout(800)
    await waitForWs(page)
    await safeShot(page, 'P09-concurrent-nav')

    // Sidebar must still be present & interactive (shell not wedged). The
    // former "Home" rail button is now labeled "K" (Sidebar.tsx DESTINATIONS).
    await expect(page.getByRole('button', { name: 'K', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible()
  } catch (e) {
    findings.push({
      title: 'Rapid navigation corrupted or wedged the shell',
      severity: 'Med',
      category: 'Bug',
      surface: 'Shell / hash routing',
      repro: 'Fire ~6 hash navigations back-to-back without awaiting.',
      expected: 'Shell lands coherently; sidebar stays interactive; WS stays green.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P09-concurrent-nav.png',
    })
  }
})

// ===========================================================================
// Fail-loud: console/page errors → findings (run after every test)
// ===========================================================================

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during a resilience/edge-case flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'P09 / various',
      repro: 'Drive the edge-case flows with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    // Network drops we deliberately induce make the browser log WS/fetch errors;
    // those are expected. Filter the obvious offline-noise so we only flag real
    // app-level console.error.
    // Exclude (a) network-drop noise from the WS test and (b) the EXPECTED 4xx
    // "Failed to load resource" the browser logs for our deliberate register-abuse
    // POSTs (malformed URL / bad path → 400). Those are the app correctly
    // rejecting bad input, surfaced inline; the browser still console.errors the
    // resource load. They are not app bugs.
    const real = sink.errors.filter(
      (e) =>
        !/websocket|ws:\/\/|failed to fetch|net::err|load failed|ERR_INTERNET_DISCONNECTED/i.test(e) &&
        !/failed to load resource.*\b(4\d\d|5\d\d)\b/i.test(e),
    )
    if (real.length) {
      findings.push({
        title: 'console.error logged during a resilience/edge-case flow',
        severity: 'High',
        category: 'Bug',
        surface: 'P09 / various',
        repro: 'Drive the edge-case flows with the console attached.',
        expected: 'No app-level console.error (network-drop noise excluded).',
        actual: real.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  // Resilient: never let a throw here lose the report.
  try {
    writeFindings('P09', CHARTER, findings)
  } catch {
    /* last-ditch: nothing more we can do */
  }
})

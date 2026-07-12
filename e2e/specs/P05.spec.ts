import { test, expect, type Page } from '@playwright/test'
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
// P05 — Skills / Automation
// Charter: seeded skills appear with type/trigger badges; create manual / schedule
// (valid + INVALID cron, invalid must be rejected) / event triggers; toggle &
// delete with persistence across reload; ONE real manual trigger → skill run +
// live console reaches terminal state (RUN_PERMISSION_MODE=plan); skill test →
// eval history + regression flag; run history. Adversarial: time everything,
// flag confusing trigger-config UX, missing validation, dead controls.
// ===========================================================================

const CHARTER =
  'Skills/Automation: seeded skills + badges, create manual/schedule(valid+invalid cron)/event, toggle+delete persistence, ONE real trigger → live console terminal, test→evals+regression, run history.'
const findings: Finding[] = []
let sink: ConsoleSink

// Shared across the serial suite.
const SEEDED = ['onboarding', 'verify-project', 'create-web-ui-artifact']
const MANUAL_SKILL = `p05-manual-${Date.now()}`
const SCHED_SKILL = `p05-sched-${Date.now()}`
const EVENT_SKILL = `p05-event-${Date.now()}`
const DELETE_SKILL = `p05-delete-${Date.now()}`
const INVALID_CRON = '99 99 * * *' // node-cron validate() === false

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// --- helpers ---------------------------------------------------------------

async function gotoSkills(page: Page): Promise<void> {
  // Legacy '#/skills/automations' (view=skills, param=automations) redirects to
  // '#/agents/skills/automations' (route.ts VIEW_REDIRECTS) — the SkillsPage sub-tab
  // that owns the AutomationsTab body (the "+ add skill" form) verbatim. A bare
  // '#/skills' would land on SkillsPage's default Catalog sub-tab instead.
  await gotoApp(page, '#/skills/automations')
  await expect(page.getByRole('button', { name: /add skill/i })).toBeVisible()
}

/** A skill row is the card whose name span text matches `name`. */
function skillRow(page: Page, name: string) {
  return page
    .locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: /run/i }) })
    .last()
}

/** Fill + submit the "add skill" form. Returns the create-error text (or ''). */
async function createSkill(
  page: Page,
  opts: {
    name: string
    source: string
    type?: 'skill' | 'hook' | 'workflow'
    trigger?: 'manual' | 'schedule' | 'event'
    cron?: string
    event?: string
  },
): Promise<{ errorText: string }> {
  // Open the form if it isn't already open.
  const addBtn = page.getByRole('button', { name: /add skill/i })
  if (await addBtn.isVisible().catch(() => false)) await addBtn.click()

  await page.getByPlaceholder('e.g. nightly-verify').fill(opts.name)
  if (opts.type) {
    await page.locator('select').first().selectOption(opts.type)
  }
  const trigger = opts.trigger ?? 'manual'
  await page.locator('select').nth(1).selectOption(trigger)
  if (trigger === 'schedule' && opts.cron !== undefined) {
    await page.getByPlaceholder('e.g. 0 2 * * *').fill(opts.cron)
  }
  if (trigger === 'event' && opts.event !== undefined) {
    await page.getByPlaceholder('e.g. done').fill(opts.event)
  }
  await page.getByPlaceholder(/Describe what this skill should do/i).fill(opts.source)

  // Client-side cron validation (web/src/pages/skills/AutomationsTab.tsx: checkCron)
  // disables the register button entirely and shows a live "skill-cron-hint" instead
  // of a post-submit red error banner — it mirrors the server's node-cron validator so
  // an unfireable cron is caught before the round trip, not after. Treat that hint as
  // the rejection's error text; there is nothing to click/submit in this case.
  if (trigger === 'schedule') {
    const hintText = await page.getByTestId('skill-cron-hint').textContent().catch(() => null)
    if (hintText?.includes('⚠')) {
      return { errorText: hintText.replace('⚠', '').trim() }
    }
  }

  await page.getByRole('button', { name: /^register$|registering/i }).click()

  // Either the form closes (success) or a red error appears (failure). Give it a beat.
  const errLoc = page.locator('.text-red-400').first()
  await page
    .waitForFunction(
      () => {
        const form = document.querySelector('form')
        const err = document.querySelector('.text-red-400')
        return !form || !!err
      },
      { timeout: 10_000 },
    )
    .catch(() => {})
  const errorText = (await errLoc.textContent().catch(() => '')) ?? ''
  return { errorText: errorText.trim() }
}

// --- tests -----------------------------------------------------------------

test('seeded skills appear with type + trigger badges', async ({ page }) => {
  await gotoSkills(page)
  await screenshot(page, 'P05-skills-list')

  for (const name of SEEDED) {
    const visible = await page
      .getByText(name, { exact: true })
      .first()
      .isVisible()
      .catch(() => false)
    if (!visible) {
      findings.push({
        title: `Seeded skill "${name}" not visible on Skills page`,
        severity: 'High',
        category: 'Missing',
        surface: 'Skills',
        repro: 'Fresh stack → open #/skills.',
        expected: `Bible §3 / seedBuiltinSkills lists ${SEEDED.join(', ')}.`,
        actual: `"${name}" was not rendered.`,
        evidence: 'reports/screens/P05-skills-list.png',
      })
    }
  }

  // Each seeded skill is a workflow + manual trigger → badges must render.
  const workflowBadges = await page.getByText('workflow', { exact: true }).count()
  const manualBadges = await page.getByText('manual', { exact: true }).count()
  if (workflowBadges < 3 || manualBadges < 3) {
    findings.push({
      title: 'Type/trigger badges missing for seeded skills',
      severity: 'Med',
      category: 'UX',
      surface: 'Skills / SkillRow badges',
      repro: 'Open #/skills, inspect badges on the 3 seeded skills.',
      expected: '3× "workflow" type badge and 3× "manual" trigger badge.',
      actual: `Saw ${workflowBadges} workflow + ${manualBadges} manual badges.`,
      evidence: 'reports/screens/P05-skills-list.png',
    })
  }
})

test('create a manual-trigger skill', async ({ page }) => {
  await gotoSkills(page)
  const { ms } = await timed(() =>
    createSkill(page, { name: MANUAL_SKILL, source: 'echo hello from a manual P05 skill', trigger: 'manual' }),
  )
  const created = await page.getByText(MANUAL_SKILL, { exact: true }).first().isVisible().catch(() => false)
  await screenshot(page, 'P05-manual-created')
  if (!created) {
    findings.push({
      title: 'Manual skill did not appear after register',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / create',
      repro: `Add skill name=${MANUAL_SKILL}, trigger=manual, fill source, register.`,
      expected: 'New skill row appears in the list.',
      actual: 'Skill not visible after submit.',
      evidence: 'reports/screens/P05-manual-created.png',
    })
  }
  if (ms > 2000) {
    findings.push({
      title: 'Create-skill round trip slow',
      severity: 'Low',
      category: 'Perf',
      surface: 'Skills / create',
      repro: 'Register a manual skill and time until the row appears.',
      expected: 'Sub-2s with feedback.',
      actual: `Took ${ms}ms.`,
      evidence: 'timing from harness.timed()',
    })
  }
})

test('schedule trigger: valid cron accepted, INVALID cron rejected (no silent accept)', async ({ page }) => {
  await gotoSkills(page)

  // Valid cron → should be accepted.
  const valid = await createSkill(page, {
    name: SCHED_SKILL,
    source: 'nightly p05 verify',
    trigger: 'schedule',
    cron: '0 2 * * *',
  })
  const validCreated = await page.getByText(SCHED_SKILL, { exact: true }).first().isVisible().catch(() => false)
  await screenshot(page, 'P05-schedule-valid')
  if (!validCreated) {
    findings.push({
      title: 'Valid cron schedule skill was rejected',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / create (schedule)',
      repro: `Add skill trigger=schedule cron="0 2 * * *".`,
      expected: 'Accepted + row shows "cron: 0 2 * * *".',
      actual: `Not created. Error="${valid.errorText}".`,
      evidence: 'reports/screens/P05-schedule-valid.png',
    })
  }

  // INVALID cron → MUST be rejected with a clear error, not silently accepted.
  const invalidName = `${SCHED_SKILL}-bad`
  const invalid = await createSkill(page, {
    name: invalidName,
    source: 'should never be stored',
    trigger: 'schedule',
    cron: INVALID_CRON,
  })
  // The row must NOT appear; an error message must be shown.
  const badCreated = await page.getByText(invalidName, { exact: true }).first().isVisible().catch(() => false)
  await screenshot(page, 'P05-schedule-invalid')

  if (badCreated) {
    findings.push({
      title: 'CRITICAL: invalid cron silently accepted',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Skills / create (schedule)',
      repro: `Add skill trigger=schedule cron="${INVALID_CRON}", register.`,
      expected: 'Server rejects with 400; UI shows an error; no row created (an unfireable cron must never be stored).',
      actual: 'Skill row WAS created with an invalid cron expression.',
      evidence: 'reports/screens/P05-schedule-invalid.png',
    })
  } else if (!invalid.errorText) {
    findings.push({
      title: 'Invalid cron rejected but with no visible error message',
      severity: 'Med',
      category: 'UX',
      surface: 'Skills / create (schedule)',
      repro: `Add skill trigger=schedule cron="${INVALID_CRON}", register.`,
      expected: 'A clear inline error explaining the cron is invalid.',
      actual: 'No row created (good) but no error text surfaced to the user.',
      evidence: 'reports/screens/P05-schedule-invalid.png',
    })
  }

  // No client-side cron validation: the only guard is the server 400. Note as UX.
  findings.push({
    title: 'No client-side cron validation / no cron field hint',
    severity: 'Low',
    category: 'UX',
    surface: 'Skills / create (schedule)',
    repro: 'Switch trigger to schedule; observe the cron input.',
    expected: 'Inline format hint / pre-submit validation so users do not learn via a 400.',
    actual: `Cron is free text; validity is only learned after submit (placeholder "0 2 * * *" only). Invalid-cron error observed = "${invalid.errorText || '(none)'}".`,
    evidence: 'reports/screens/P05-schedule-invalid.png',
  })
})

test('event trigger skill creates and shows the event badge', async ({ page }) => {
  await gotoSkills(page)
  const res = await createSkill(page, {
    name: EVENT_SKILL,
    source: 'react to a finished run',
    trigger: 'event',
    event: 'done',
  })
  const created = await page.getByText(EVENT_SKILL, { exact: true }).first().isVisible().catch(() => false)
  await screenshot(page, 'P05-event-created')
  if (!created) {
    findings.push({
      title: 'Event-trigger skill was not created',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / create (event)',
      repro: `Add skill trigger=event eventTrigger="done".`,
      expected: 'Accepted + row shows trigger badge "event" and "on: done".',
      actual: `Not created. Error="${res.errorText}".`,
      evidence: 'reports/screens/P05-event-created.png',
    })
  }

  // Adversarial: event trigger with EMPTY event name must be rejected (server 400).
  const emptyEventName = `${EVENT_SKILL}-noevent`
  const emptyRes = await createSkill(page, {
    name: emptyEventName,
    source: 'no event name',
    trigger: 'event',
    event: '',
  })
  const emptyCreated = await page.getByText(emptyEventName, { exact: true }).first().isVisible().catch(() => false)
  if (emptyCreated) {
    findings.push({
      title: 'Event trigger accepted with no event name',
      severity: 'Med',
      category: 'Bug',
      surface: 'Skills / create (event)',
      repro: `Add skill trigger=event with empty eventTrigger.`,
      expected: 'Server 400: event trigger requires an eventTrigger name.',
      actual: 'Skill created with no event name (would never fire).',
      evidence: 'event-empty create returned no error',
    })
  } else if (!emptyRes.errorText) {
    findings.push({
      title: 'Empty-event skill rejected but no visible error',
      severity: 'Low',
      category: 'UX',
      surface: 'Skills / create (event)',
      repro: 'Add event-trigger skill with empty event name, register.',
      expected: 'Inline error explaining an event name is required.',
      actual: 'Rejected (good) but no error surfaced.',
      evidence: 'no .text-red-400 after submit',
    })
  }
})

test('toggle disable/enable + delete persist across reload', async ({ page }) => {
  await gotoSkills(page)

  // Create a dedicated, disposable skill so we don't disturb seeded ones.
  await createSkill(page, { name: DELETE_SKILL, source: 'disposable', trigger: 'manual' })
  await expect(page.getByText(DELETE_SKILL, { exact: true }).first()).toBeVisible()

  const row = skillRow(page, DELETE_SKILL)
  // Toggle button has title Enable/Disable.
  const toggle = row.getByRole('button', { name: /disable|enable/i }).first()

  // Disable it.
  await toggle.click().catch(() => {})
  // After disable, a "disabled" badge should render on the row.
  let disabledBadge = await row.getByText('disabled', { exact: true }).isVisible().catch(() => false)
  await screenshot(page, 'P05-toggled-disabled')

  // Reload and confirm persistence.
  await page.reload()
  await waitForWs(page)
  await expect(page.getByRole('button', { name: /add skill/i })).toBeVisible()
  const rowAfter = skillRow(page, DELETE_SKILL)
  const disabledPersisted = await rowAfter.getByText('disabled', { exact: true }).isVisible().catch(() => false)

  if (!disabledBadge) {
    findings.push({
      title: 'Disabling a skill shows no immediate visual state',
      severity: 'Med',
      category: 'UX',
      surface: 'Skills / SkillRow toggle',
      repro: `Click the toggle dot on ${DELETE_SKILL}.`,
      expected: 'A "disabled" badge appears immediately.',
      actual: 'No disabled badge observed after toggle.',
      evidence: 'reports/screens/P05-toggled-disabled.png',
    })
  }
  if (!disabledPersisted) {
    findings.push({
      title: 'Disabled state did not persist across reload',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / toggle persistence',
      repro: `Disable ${DELETE_SKILL}, reload #/skills.`,
      expected: 'Skill remains disabled after reload (PATCH persisted).',
      actual: 'Skill was no longer disabled after reload.',
      evidence: 'reports/screens/P05-toggled-disabled.png',
    })
  }

  // Re-enable then delete.
  const reTabRow = skillRow(page, DELETE_SKILL)
  await reTabRow.getByRole('button', { name: /enable|disable/i }).first().click().catch(() => {})
  await reTabRow.getByRole('button', { name: /^delete$/i }).click().catch(() => {})

  // Confirm gone, then gone after reload too.
  await expect(page.getByText(DELETE_SKILL, { exact: true })).toHaveCount(0, { timeout: 10_000 }).catch(() => {})
  await page.reload()
  await waitForWs(page)
  const stillThere = await page.getByText(DELETE_SKILL, { exact: true }).count()
  await screenshot(page, 'P05-deleted')
  if (stillThere > 0) {
    findings.push({
      title: 'Deleted skill reappears after reload',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / delete persistence',
      repro: `Delete ${DELETE_SKILL}, reload #/skills.`,
      expected: 'Skill stays deleted (DELETE persisted).',
      actual: 'Skill reappeared after reload.',
      evidence: 'reports/screens/P05-deleted.png',
    })
  }

  // Dead-control check: delete has no confirm dialog (destructive, one click).
  findings.push({
    title: 'Delete is a single unconfirmed click (destructive)',
    severity: 'Low',
    category: 'UX',
    surface: 'Skills / SkillRow delete',
    repro: 'Click "delete" on any skill row.',
    expected: 'A confirm step for a destructive, irreversible action (esp. for seeded skills).',
    actual: 'Skill is deleted immediately with no confirmation.',
    evidence: 'SkillRow onDelete fires deleteMutation directly',
  })
})

test('trigger affordance: run button present but no in-page feedback wiring (UX, no dispatch)', async ({ page }) => {
  // Budget guard: do NOT fire a dispatch here (the single real trigger is the
  // next test). We only inspect the affordance + the absence of feedback wiring.
  await gotoSkills(page)
  await expect(page.getByText(MANUAL_SKILL, { exact: true }).first()).toBeVisible().catch(() => {})
  const row = skillRow(page, MANUAL_SKILL)
  const runBtnVisible = await row.getByRole('button', { name: /run/i }).first().isVisible().catch(() => false)
  if (!runBtnVisible) {
    findings.push({
      title: 'No "▶ run" trigger control on skill row',
      severity: 'High',
      category: 'Missing',
      surface: 'Skills / SkillRow',
      repro: `Inspect ${MANUAL_SKILL} row for a manual-trigger control.`,
      expected: 'A "▶ run" button to manually trigger the skill.',
      actual: 'No run control located.',
      evidence: 'SkillRow render',
    })
  }
  await screenshot(page, 'P05-trigger-affordance')
  // triggerMutation has no onSuccess: no toast, no navigation, no link to the run.
  findings.push({
    title: 'Manual trigger gives no confirmation or link to the run',
    severity: 'Med',
    category: 'UX',
    surface: 'Skills / SkillRow ▶ run',
    repro: `Click "▶ run" on a skill; watch the page.`,
    expected: 'A toast/confirmation and a link to the just-created run (API returns {skillRunId, runId}).',
    actual: 'triggerMutation has no onSuccess handler — only a transient "…" on the button; user must manually open Runs and guess which run is theirs.',
    evidence: 'reports/screens/P05-trigger-affordance.png; SkillsPage triggerMutation (line ~66)',
  })
})

test('REAL RUN (budget=1): manual trigger reaches a terminal state with a live console', async ({ page }) => {
  await gotoSkills(page)
  await expect(page.getByText(MANUAL_SKILL, { exact: true }).first()).toBeVisible().catch(() => {})

  // Snapshot existing run count via the Runs list, then trigger, then look for a new run.
  const row = skillRow(page, MANUAL_SKILL)
  const { ms: triggerMs } = await timed(async () => {
    await row.getByRole('button', { name: /run/i }).first().click()
    await page.waitForTimeout(500)
  })

  // Navigate to Runs and open the most recent run (the skill source is short).
  await gotoApp(page, '#/runs')
  // The run list refetches every 5s + live WS; give the new run time to appear.
  let opened = false
  try {
    const firstRun = page.locator('[role="button"]').filter({ hasText: /running|queued|done|error/ }).first()
    await firstRun.waitFor({ state: 'visible', timeout: 20_000 })
    await firstRun.click()
    opened = true
  } catch {
    // fall through
  }
  await screenshot(page, 'P05-run-console')

  if (!opened) {
    findings.push({
      title: 'Triggered skill produced no visible run in Runs',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills trigger → Runs',
      repro: `Trigger ${MANUAL_SKILL}, open #/runs.`,
      expected: 'A new run appears in the run list within seconds.',
      actual: 'No run row appeared.',
      evidence: 'reports/screens/P05-run-console.png',
    })
    return
  }

  // Live console: header shows a status pill; wait for a terminal state.
  // RUN_PERMISSION_MODE=plan + real claude CLI present at ~/.local/bin/claude.
  const terminal = page.locator('text=/^(done|error|killed|interrupted)$/').first()
  let reachedTerminal = false
  let finalStatus = 'unknown'
  try {
    await terminal.waitFor({ state: 'visible', timeout: 60_000 })
    finalStatus = (await terminal.textContent())?.trim() ?? 'unknown'
    reachedTerminal = true
  } catch {
    // not terminal in time
  }
  await screenshot(page, 'P05-run-terminal')

  // Did the console show *any* output (not stuck on "Waiting for output…")?
  const waiting = await page.getByText('Waiting for output…').isVisible().catch(() => false)

  if (!reachedTerminal) {
    findings.push({
      title: 'Skill run did not reach a terminal state within 60s',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills trigger → RunConsole',
      repro: `Trigger ${MANUAL_SKILL}, open the run in #/runs, wait.`,
      expected: 'Run reaches done/error/killed/interrupted; console streams events.',
      actual: `Still non-terminal after 60s. Console "Waiting for output…" visible=${waiting}.`,
      evidence: 'reports/screens/P05-run-terminal.png',
    })
  } else if (finalStatus === 'error') {
    // claude CLI present, plan mode — capture whatever the console shows.
    const consoleText = (await page.locator('.font-mono').first().textContent().catch(() => '')) ?? ''
    findings.push({
      title: 'Real skill trigger ran but the underlying run errored (recorded)',
      severity: 'Med',
      category: 'Bug',
      surface: 'Skills trigger → RunConsole',
      repro: `Trigger ${MANUAL_SKILL} (echo prompt), observe run in #/runs.`,
      expected: 'A safe plan-mode dispatch completes (done) or errors with a clear reason.',
      actual: `Run reached terminal state "error". Console excerpt: ${consoleText.slice(0, 400)}`,
      evidence: 'reports/screens/P05-run-terminal.png',
    })
  }
  // Record the real-run outcome regardless (load-bearing for the report).
  findings.push({
    title: `Real-run outcome: terminal=${reachedTerminal} status=${finalStatus}`,
    severity: 'Nit',
    category: 'Docs-mismatch',
    surface: 'Skills trigger → RunConsole',
    repro: `Single live dispatch of ${MANUAL_SKILL} under RUN_PERMISSION_MODE=plan.`,
    expected: 'Documented for the swarm report.',
    actual: `triggerClick→500ms=${triggerMs}ms; terminal=${reachedTerminal}; finalStatus=${finalStatus}; waiting=${waiting}.`,
    evidence: 'reports/screens/P05-run-console.png, P05-run-terminal.png',
  })
})

test('skill test → eval row appears in history (regression flag reachable)', async ({ page }) => {
  await gotoSkills(page)
  // Use the cheap manual skill for the test/eval path (no extra live agent budget
  // concern — test() is a separate dispatch but cheap echo source).
  const row = skillRow(page, MANUAL_SKILL)
  const testBtn = row.getByRole('button', { name: /^test$/i }).first()
  let clicked = false
  try {
    await testBtn.click()
    clicked = true
  } catch { /* dead/absent control */ }

  if (!clicked) {
    findings.push({
      title: 'Skill "test" control not reachable',
      severity: 'Med',
      category: 'Missing',
      surface: 'Skills / SkillRow test',
      repro: `Click "test" on ${MANUAL_SKILL}.`,
      expected: 'Test button dispatches an eval-harness run.',
      actual: 'Test button could not be clicked.',
      evidence: 'no test button located in row',
    })
  } else {
    // An eval badge ("eval: pass|fail|pending") should eventually render on the row.
    const evalBadge = page.locator('text=/eval:\\s*(pass|fail|pending)/i').first()
    let sawEval = false
    try {
      await evalBadge.waitFor({ state: 'visible', timeout: 60_000 })
      sawEval = true
    } catch { /* no eval badge */ }
    await screenshot(page, 'P05-eval-badge')
    if (!sawEval) {
      findings.push({
        title: 'Skill test produced no eval badge within 60s',
        severity: 'Med',
        category: 'Bug',
        surface: 'Skills / evals',
        repro: `Click "test" on ${MANUAL_SKILL}; wait for eval badge.`,
        expected: 'An "eval: pass|fail|pending" badge appears (GET /skills/:id/evals).',
        actual: 'No eval badge rendered after 60s.',
        evidence: 'reports/screens/P05-eval-badge.png',
      })
    }
    // Regression flag UX note: there is no in-UI "eval history" list — only the
    // single latest-eval badge + a "⚠ regression" badge. Record the gap.
    findings.push({
      title: 'No eval *history* surface — only latest eval badge',
      severity: 'Low',
      category: 'Missing',
      surface: 'Skills / evals + regression',
      repro: 'Run "test" multiple times and look for an eval history list.',
      expected: 'Bible/charter implies eval history + regression tracking; UI shows only the latest badge.',
      actual: 'SkillRow renders only evals[0] and a regression badge; no history list / no per-eval drill-down in the UI.',
      evidence: 'reports/screens/P05-eval-badge.png; SkillsPage SkillRow uses evals[0]',
    })
  }
})

test('run history (GET /skills/:id/runs) has no UI surface', async ({ page }) => {
  await gotoSkills(page)
  // The api exposes api.skills.runs(id) but SkillsPage never calls it — there is
  // no "view run history" control on a skill row. Verify the absence as a finding.
  const row = skillRow(page, MANUAL_SKILL)
  const historyCtl = await row
    .getByRole('button', { name: /history|runs/i })
    .first()
    .isVisible()
    .catch(() => false)
  if (!historyCtl) {
    findings.push({
      title: 'Skill run-history API exists but has no UI control',
      severity: 'Med',
      category: 'Missing',
      surface: 'Skills / run history',
      repro: 'Inspect a skill row for a "view run history" affordance.',
      expected: 'A way to view a skill\'s run history (GET /api/skills/:id/runs is implemented).',
      actual: 'No history control on the row; api.skills.runs() is dead from the UI. User must use the global Runs tab and guess which runs came from which skill.',
      evidence: 'SkillsPage never calls api.skills.runs',
    })
  }
})

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during Skills flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Skills',
      repro: 'Drive the Skills flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  // The adversarial negative paths (invalid cron, empty event) deliberately
  // provoke server 400s; Chromium logs a generic "Failed to load resource …400"
  // for every non-2xx fetch. Those are EXPECTED here and are not app-level
  // console.error()s, so filter them out to avoid false-positive High findings.
  const unexpected = (sink?.errors ?? []).filter(
    e => !/Failed to load resource.*\b(400|409)\b/i.test(e),
  )
  if (unexpected.length) {
    findings.push({
      title: 'Unexpected console.error logged during Skills flow',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills',
      repro: 'Drive the Skills flow with the console attached.',
      expected: 'No unexpected console.error in a clean session (intentional 400/409 rejections excluded).',
      actual: unexpected.join('\n').slice(0, 800),
      evidence: 'page.on("console") capture (expected 400/409 resource errors filtered)',
    })
  }
})

test.afterAll(() => {
  try {
    writeFindings('P05', CHARTER, findings)
  } catch (e) {
    // Resilient: never let a report-write failure mask the run.
    // eslint-disable-next-line no-console
    console.error('writeFindings failed', e)
  }
})

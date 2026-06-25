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
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// P04 — Verification / Maintenance
// Charter: register a fixture project, run verification (rerun) + deep verify,
// assert health score (0–100), breakdown bars (bar-*), findings-by-severity.
// Sanity-check the rendered score against the documented §5 formula
// (40·CI + 20·coverage-trend + 20·bible-freshness + 20·findings); re-run and
// confirm the history grows; inspect severity grouping; time the runs and flag
// long waits with no progress indicator; verify a never-onboarded project and
// record how findings/score reflect the missing invariants. Adversarial +
// critical: record claims-vs-reality gaps as Docs-mismatch.
// ===========================================================================

const CHARTER =
  'Verification/maintenance: register a fixture, run rerun + deep verify, assert score/bars/findings, sanity-check vs bible §5 formula, confirm history grows, inspect severity grouping, time runs, and verify a never-onboarded project.'
const findings: Finding[] = []
let sink: ConsoleSink

// The bible §5 / core verify.ts contract for a BARE local fixture (no GitHub
// remote, no .github/workflows, no docs/bible/manifest.json):
//   CI       = none      → 0/40   (auditCi critical: "no CI workflow")
//   Coverage = unknown   → 20/20  (neutral, no signal wired — bible admits this)
//   Bible    = not fresh → 0/20   (auditBible critical: "no project bible")
//   Findings = 20 − (3 criticals × 10) = −10 → floor 0/20
//             (auditCi critical + auditBible critical + invariants no-remote critical)
//   score    = 0 + 20 + 0 + 0 = 20
const EXPECTED_BARE = { score: 20, ci: 0, coverage: 20, bible: 0, findings: 0 }

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

/** Register a project through the real Register modal (adversarial: drive the
 *  browser, not the API). Returns nothing — caller navigates to Projects first. */
async function registerViaModal(page: Page, name: string, localPath: string): Promise<void> {
  await page.getByRole('button', { name: /register project/i }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Two inputs: [0]=name (autoFocus), [1]=source (local path or GitHub URL). The
  // source placeholder uses backslashes ("C:\path\to\repo …") so match by index.
  const inputs = dialog.locator('input')
  await inputs.nth(0).fill(name)
  await inputs.nth(1).fill(localPath)
  await dialog.getByRole('button', { name: /Register/i }).click()
  // Modal closes on success; the card should appear in the fleet.
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
}

/** Open the verify surface for the only project in the fleet by clicking its
 *  "Run verification" card button (records a finding if that path is broken,
 *  then falls back to deriving the id from the card so the run can continue). */
async function openVerifyForFirstProject(page: Page): Promise<boolean> {
  await gotoApp(page, '#/projects')
  const runBtn = page.getByRole('button', { name: /Run verification/i }).first()
  try {
    await runBtn.click({ timeout: 10_000 })
    await page.waitForURL(/#\/verify\//, { timeout: 15_000 })
    await waitForWs(page)
    return true
  } catch (e) {
    findings.push({
      title: 'Could not reach the verify surface from a project card',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectsPage / ProjectCard "Run verification"',
      repro: 'Projects → click a card\'s "▶ Run verification".',
      expected: 'Navigates to #/verify/<id>.',
      actual: `No card / button reachable: ${String(e).slice(0, 200)}`,
      evidence: 'reports/screens/P04-register.png',
    })
    return false
  }
}

test('register a fixture project and reach the verify surface', async ({ page }) => {
  const repo = makeScratchRepo('P04', 'verify-a')
  await gotoApp(page, '#/projects')

  try {
    await registerViaModal(page, 'P04-verify-a', repo)
  } catch (e) {
    findings.push({
      title: 'Register modal flow failed for a local fixture path',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectsPage / Register modal',
      repro: 'Projects → + register project → fill name + local path → Register.',
      expected: 'Project registers and a card appears in the fleet.',
      actual: `Modal flow threw: ${String(e).slice(0, 300)}`,
      evidence: 'reports/screens/P04-register.png',
    })
  }
  await screenshot(page, 'P04-register')

  const reached = await openVerifyForFirstProject(page)
  if (!reached) return
  // Pre-verify: page should show the empty "no reports yet" state.
  await expect(page.getByText(/no verification reports yet/i)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'P04-verify-empty')
})

test('rerun verification renders score, breakdown bars, and findings', async ({ page }) => {
  if (!(await openVerifyForFirstProject(page))) return

  const rerun = page.getByTestId('verify-rerun')
  await expect(rerun).toBeVisible()

  // Time the run. There is NO progress indicator beyond the button label
  // flipping to "verifying…"; record if there's a perceptible wait with no
  // feedback. We wait for the score block to render as the completion signal.
  const scoreLocator = page.locator('.text-3xl').first()
  const { ms } = await timed(async () => {
    await rerun.click()
    await expect(scoreLocator).toBeVisible({ timeout: 30_000 })
  })

  await screenshot(page, 'P04-verify-scored')

  // ── Score is an integer in [0,100] ──────────────────────────────────────
  const scoreText = (await scoreLocator.textContent())?.trim() ?? ''
  const score = Number(scoreText)
  expect(Number.isFinite(score)).toBe(true)
  if (!(Number.isInteger(score) && score >= 0 && score <= 100)) {
    findings.push({
      title: 'Health score is not a clean integer in [0,100]',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectVerification / score',
      repro: 'Register a local fixture → Re-run verification → read the big score.',
      expected: 'An integer 0–100 (bible §5: "0–100 health score").',
      actual: `Rendered score text: "${scoreText}".`,
      evidence: 'reports/screens/P04-verify-scored.png',
    })
  }

  // ── All four breakdown bars render with value/max ────────────────────────
  const bars: Record<string, { value: number; max: number }> = {}
  for (const key of ['ci', 'coverage', 'bible', 'findings']) {
    const bar = page.getByTestId(`bar-${key}`)
    try {
      await expect(bar).toBeVisible({ timeout: 5_000 })
      const txt = (await bar.textContent()) ?? ''
      const m = txt.match(/(\d+)\s*\/\s*(\d+)/)
      if (m) bars[key] = { value: Number(m[1]), max: Number(m[2]) }
    } catch {
      findings.push({
        title: `Breakdown bar "${key}" did not render`,
        severity: 'Med',
        category: 'Missing',
        surface: 'ProjectVerification / breakdown',
        repro: 'Re-run verification, inspect the score breakdown bars.',
        expected: `A bar-${key} testid with a value/max label.`,
        actual: `bar-${key} was not visible.`,
        evidence: 'reports/screens/P04-verify-scored.png',
      })
    }
  }

  // ── §5 formula sanity-check: bars must sum to the score, and weighted maxes
  //    must match the documented 40/20/20/20. ───────────────────────────────
  const expectedMax = { ci: 40, coverage: 20, bible: 20, findings: 20 }
  for (const [key, max] of Object.entries(expectedMax)) {
    if (bars[key] && bars[key].max !== max) {
      findings.push({
        title: `Breakdown max for "${key}" disagrees with bible §5`,
        severity: 'Med',
        category: 'Docs-mismatch',
        surface: 'ProjectVerification / breakdown',
        repro: 'Re-run verification, read the "value/max" on each bar.',
        expected: `bible §5 weight for ${key} = ${max}.`,
        actual: `UI shows max ${bars[key].max}.`,
        evidence: 'reports/screens/P04-verify-scored.png',
      })
    }
  }
  if (Object.keys(bars).length === 4) {
    const sum = bars.ci.value + bars.coverage.value + bars.bible.value + bars.findings.value
    if (sum !== score) {
      findings.push({
        title: 'Breakdown bars do not sum to the displayed health score',
        severity: 'High',
        category: 'Docs-mismatch',
        surface: 'ProjectVerification / breakdown vs score',
        repro: 'Re-run verification; add the four bar values; compare to the big score.',
        expected: `Sum of bars == score (bible §5: score = 40·CI+20·cov+20·bible+20·find). Score=${score}.`,
        actual: `Bars sum to ${sum} (ci=${bars.ci.value}, cov=${bars.coverage.value}, bible=${bars.bible.value}, find=${bars.findings.value}).`,
        evidence: 'reports/screens/P04-verify-scored.png',
      })
    }
    // For a bare local fixture the deterministic engine pins exact values.
    const got = {
      score,
      ci: bars.ci.value,
      coverage: bars.coverage.value,
      bible: bars.bible.value,
      findings: bars.findings.value,
    }
    if (JSON.stringify(got) !== JSON.stringify(EXPECTED_BARE)) {
      findings.push({
        title: 'Bare-fixture score/breakdown differs from the §5 contract',
        severity: 'Med',
        category: 'Docs-mismatch',
        surface: 'ProjectVerification / §5 formula',
        repro: 'Verify a bare local fixture (no remote/CI/bible).',
        expected: `Per core/src/verify.ts + bible §5: ${JSON.stringify(EXPECTED_BARE)} (CI none=0, coverage unknown=20 neutral, bible absent=0, findings floored to 0 by 3 criticals).`,
        actual: JSON.stringify(got),
        evidence: 'reports/screens/P04-verify-scored.png',
      })
    }

    // ── Coverage honesty check: coverage is full marks while NO signal is
    //    wired. The bible admits this, but the UI bar shows a full "20/20"
    //    with no "unknown/neutral" caveat — easy to misread as real coverage.
    if (bars.coverage.value === bars.coverage.max) {
      findings.push({
        title: 'Coverage bar shows full marks with no "unknown/neutral" caveat',
        severity: 'Med',
        category: 'UX',
        surface: 'ProjectVerification / Coverage bar',
        repro: 'Verify any project; look at the Coverage breakdown bar.',
        expected:
          'Since no coverage signal is wired (bible §5 "coverage trend = neutral today"), the UI should label the full bar as unknown/neutral so the operator does not read it as measured coverage.',
        actual: `Coverage renders a full ${bars.coverage.value}/${bars.coverage.max} bar identical to a genuinely passing factor — no "unknown" hint in the UI.`,
        evidence: 'reports/screens/P04-verify-scored.png',
      })
    }
  }

  // ── Findings list renders, grouped by severity ───────────────────────────
  const findingsHeader = page.getByText('Findings', { exact: true }).first()
  await expect(findingsHeader).toBeVisible()
  // A bare fixture must surface the missing-CI + missing-bible + no-remote criticals.
  const hasCiFinding = await page
    .getByText(/no CI workflow/i)
    .first()
    .isVisible()
    .catch(() => false)
  const hasBibleFinding = await page
    .getByText(/no project bible/i)
    .first()
    .isVisible()
    .catch(() => false)
  const hasRemoteFinding = await page
    .getByText(/no GitHub remote/i)
    .first()
    .isVisible()
    .catch(() => false)
  if (!hasCiFinding || !hasBibleFinding || !hasRemoteFinding) {
    findings.push({
      title: 'Bare-fixture missing-invariant findings not all surfaced',
      severity: 'Med',
      category: 'Bug',
      surface: 'ProjectVerification / Findings',
      repro: 'Verify a never-onboarded local fixture; read the Findings list.',
      expected:
        'Three criticals: "no CI workflow…", "no project bible…", "no GitHub remote…" (core composeFindings).',
      actual: `Visible — ci:${hasCiFinding} bible:${hasBibleFinding} remote:${hasRemoteFinding}.`,
      evidence: 'reports/screens/P04-verify-scored.png',
    })
  }

  // ── Perf: flag a slow run with only a button-label as feedback ───────────
  if (ms > 1000) {
    findings.push({
      title: 'Verification run has weak progress feedback',
      severity: ms > 5000 ? 'Med' : 'Low',
      category: 'Perf',
      surface: 'ProjectVerification / Re-run',
      repro: 'Click Re-run and watch for a progress indicator while it runs.',
      expected: 'A spinner/progress affordance for waits >1s; the button label flip is subtle.',
      actual: `Re-run took ${ms}ms to render a score; the only feedback is the button text changing to "verifying…".`,
      evidence: 'reports/screens/P04-verify-scored.png; harness.timed().',
    })
  }
})

test('re-run grows the history timeline; deep-verify button present (not fired)', async ({ page }) => {
  if (!(await openVerifyForFirstProject(page))) return

  // History growth is validated via the DETERMINISTIC re-run path. We do NOT
  // click "Deep verify": per core/src/routes/projects.ts, deep:true ALSO fires a
  // real `claude` verify-project agent dispatch (fire-and-forget). The Hybrid
  // budget does not authorize P04 to fire a real dispatch, and an early run
  // confirmed that spawn destabilizes the single-operator stack (subsequent
  // page.goto hung → worker OOM/crash, exit 134). So we assert the button is
  // present + enabled and record the behavior, rather than triggering the agent.
  const deep = page.getByTestId('verify-deep')
  await expect(deep).toBeVisible()
  await expect(deep).toBeEnabled()

  const historyItems = page.locator('ol li')
  const before = await historyItems.count().catch(() => 0)

  const { ms } = await timed(async () => {
    await page.getByTestId('verify-rerun').click()
    await expect
      .poll(async () => historyItems.count().catch(() => before), { timeout: 30_000 })
      .toBeGreaterThan(before)
  })

  const after = await historyItems.count().catch(() => 0)
  await screenshot(page, 'P04-deep-history')

  if (!(after > before)) {
    findings.push({
      title: 'History timeline did not grow after a verification run',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectVerification / History',
      repro: 'Open verify with ≥1 report → Re-run → count history rows.',
      expected: 'Each verify appends a row to the History timeline (newest first).',
      actual: `History rows before=${before}, after=${after}.`,
      evidence: 'reports/screens/P04-deep-history.png',
    })
  }

  // A "latest" marker should tag exactly one row.
  const latestTags = await page.getByText('latest', { exact: true }).count().catch(() => 0)
  if (latestTags !== 1) {
    findings.push({
      title: 'History "latest" marker is missing or duplicated',
      severity: 'Low',
      category: 'UX',
      surface: 'ProjectVerification / History',
      repro: 'Run ≥2 verifications; count rows tagged "latest".',
      expected: 'Exactly one row tagged "latest".',
      actual: `Found ${latestTags} "latest" tags.`,
      evidence: 'reports/screens/P04-deep-history.png',
    })
  }

  // Record the deep-verify behavior as a UX/safety observation (not a bug).
  findings.push({
    title: 'Deep verify silently fires a real agent dispatch with no confirm/cost warning',
    severity: 'Low',
    category: 'UX',
    surface: 'ProjectVerification / Deep verify',
    repro: 'Click "Deep verify" on any project.',
    expected:
      'A single click that spends real model budget (a claude verify-project run) should warn/confirm before dispatching, like the run confirm card elsewhere.',
    actual:
      'Deep verify returns the deterministic report immediately AND fire-and-forgets a real `claude` agent run (core/src/routes/projects.ts deep:true) with no confirm step; the only feedback is the button label flipping to "dispatching…". (P04 did not fire it — out of the Hybrid budget.)',
    evidence: 'core/src/routes/projects.ts:88-94; ProjectVerification.tsx verify-deep button.',
  })

  if (ms > 1000) {
    findings.push({
      title: 'Re-run verification has weak progress feedback',
      severity: ms > 5000 ? 'Med' : 'Low',
      category: 'Perf',
      surface: 'ProjectVerification / Re-run',
      repro: 'Click Re-run; watch for a progress indicator.',
      expected: 'A progress affordance for multi-second waits.',
      actual: `Re-run took ${ms}ms to grow history; only the button label changes to "verifying…".`,
      evidence: 'reports/screens/P04-deep-history.png; harness.timed().',
    })
  }
})

test('re-running again confirms the history keeps growing and stays ordered', async ({ page }) => {
  if (!(await openVerifyForFirstProject(page))) return
  const historyItems = page.locator('ol li')
  const before = await historyItems.count().catch(() => 0)

  await page.getByTestId('verify-rerun').click()
  await expect
    .poll(async () => historyItems.count().catch(() => before), { timeout: 30_000 })
    .toBeGreaterThan(before)
  const after = await historyItems.count().catch(() => 0)

  // History scores should be newest-first. Read the leading number of each row.
  const scores: number[] = []
  for (let i = 0; i < after; i++) {
    const txt = (await historyItems.nth(i).textContent()) ?? ''
    const m = txt.match(/\d+/)
    if (m) scores.push(Number(m[0]))
  }
  await screenshot(page, 'P04-rerun-history')

  if (!(after > before)) {
    findings.push({
      title: 'Second re-run did not append to history',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectVerification / History',
      repro: 'Re-run verification a second time; count history rows.',
      expected: 'History grows by one per run.',
      actual: `before=${before}, after=${after}.`,
      evidence: 'reports/screens/P04-rerun-history.png',
    })
  }

  // For an unchanged bare fixture every run should yield the identical score (20).
  const allBare = scores.every(s => s === EXPECTED_BARE.score)
  if (scores.length > 0 && !allBare) {
    findings.push({
      title: 'Repeat verifications of an unchanged fixture yield inconsistent scores',
      severity: 'Low',
      category: 'Bug',
      surface: 'ProjectVerification / determinism',
      repro: 'Re-run verification multiple times on the same unchanged bare fixture.',
      expected: `Deterministic engine → identical score (${EXPECTED_BARE.score}) every run.`,
      actual: `History scores: [${scores.join(', ')}].`,
      evidence: 'reports/screens/P04-rerun-history.png',
    })
  }
})

// Screenshot that never throws — a crashed/closed page must not abort the run
// before writeFindings (RUNBOOK resilient-spec rule). Records nothing on failure.
async function safeShot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* page/context closed — ignore, we still want to finish + writeFindings */
  }
}

test('verifying a second never-onboarded fixture reflects missing invariants', async ({ page }) => {
  try {
    const repo = makeScratchRepo('P04', 'verify-b')
    await gotoApp(page, '#/projects')
    try {
      await registerViaModal(page, 'P04-verify-b', repo)
    } catch (e) {
      findings.push({
        title: 'Could not register the second fixture for the not-onboarded check',
        severity: 'Med',
        category: 'Bug',
        surface: 'ProjectsPage / Register modal',
        repro: 'Register a second local fixture.',
        expected: 'Second project registers.',
        actual: String(e).slice(0, 300),
        evidence: 'reports/screens/P04-verify-b-register.png',
      })
    }
    await safeShot(page, 'P04-verify-b-register')

    // Navigate directly to this card's verify page (click the card whose name matches).
    const cardRoot = page.locator('div[role="button"]', { hasText: 'P04-verify-b' }).first()
    await cardRoot.scrollIntoViewIfNeeded().catch(() => {})
    try {
      await cardRoot.getByRole('button', { name: /Run verification/i }).click()
      await page.waitForURL(/#\/verify\//, { timeout: 15_000 })
      await waitForWs(page)
    } catch {
      // Fallback: use the first project's verify button if scoping failed.
      if (!(await openVerifyForFirstProject(page))) return
    }

    await page.getByTestId('verify-rerun').click()
    await expect(page.locator('.text-3xl').first()).toBeVisible({ timeout: 30_000 })
    const scoreText = (await page.locator('.text-3xl').first().textContent())?.trim() ?? ''
    const score = Number(scoreText)
    await safeShot(page, 'P04-verify-b-scored')

    // A never-onboarded project should NOT score "healthy" (green ≥75). It should
    // land at the documented 20 and be flagged for attention.
    if (Number.isFinite(score) && score >= 75) {
      findings.push({
        title: 'Never-onboarded project scores as "healthy"',
        severity: 'High',
        category: 'Bug',
        surface: 'ProjectVerification / score',
        repro: 'Register a bare local fixture (no remote/CI/bible) → Re-run verification.',
        expected: 'Missing invariants should keep the score low (bible §5: CI=0, bible=0, 3 criticals → ~20).',
        actual: `Score rendered as ${score}, which is in the green "healthy" band.`,
        evidence: 'reports/screens/P04-verify-b-scored.png',
      })
    } else if (Number.isFinite(score) && score !== EXPECTED_BARE.score) {
      findings.push({
        title: 'Never-onboarded score differs from the documented bare-fixture value',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: 'ProjectVerification / §5 formula',
        repro: 'Verify a bare local fixture.',
        expected: `bible §5 / verify.ts → ${EXPECTED_BARE.score}.`,
        actual: `Score ${score}.`,
        evidence: 'reports/screens/P04-verify-b-scored.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Never-onboarded verification flow crashed mid-run',
      severity: 'Med',
      category: 'Bug',
      surface: 'ProjectVerification / verify-b',
      repro: 'Register a 2nd bare fixture then verify it.',
      expected: 'Flow completes; score renders.',
      actual: `Threw (possibly a browser/page crash): ${String(e).slice(0, 200)}`,
      evidence: 'reports/screens/P04-verify-b-register.png',
    })
  }
})

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during verification flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'ProjectVerification',
      repro: 'Drive the verify flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    findings.push({
      title: 'console.error logged during verification flow',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectVerification',
      repro: 'Drive the verify flow with the console attached.',
      expected: 'No console.error in a clean session.',
      actual: sink.errors.join('\n').slice(0, 800),
      evidence: 'page.on("console") capture',
    })
  }
})

test.afterAll(() => {
  writeFindings('P04', CHARTER, findings)
})

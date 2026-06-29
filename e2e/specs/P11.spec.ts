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
// P11 — Workflow Status Checklist (Phase-5 surface)
// Charter: critically user-test the explicit workflow progress checklist
// (WorkflowChecklist, data-testid="wf-checklist") on #/workflows → "Run tree":
//   • Does the Workflows shell + both tabs render without a module-eval crash?
//   • Does the Run-tree tab degrade gracefully on an empty DB (no runs)?
//   • Does the data path that feeds the checklist (GET
//     /api/runs/:id/workflow-steps) degrade gracefully for a missing /
//     non-delegation / malformed run id (never 500)?
//   • Deep-link to a bogus run (#/workflows/<id>) must not crash; the checklist
//     is correctly omitted when there is no workflow_run.
//
// CONSTRAINT (charter + RUNBOOK): no real `claude` dispatch. The populated
// checklist only renders for delegation-workflow runs (wf.workflowRun truthy),
// which require a real multi-agent dispatch to create a workflow_run + steps —
// there is no HTTP seed route and better-sqlite3 is not resolvable from e2e. So
// the POPULATED rendering (status glyphs / kind badges / overall-status) cannot
// be exercised within budget; that observability gap is recorded as a finding.
//
// Resilient (RUNBOOK): every exploratory interaction is wrapped so one broken
// surface can never abort the run before writeFindings. Only WS reachability is
// hard-asserted. Modeled EXACTLY on P01/P09/P10.
// ===========================================================================

const CHARTER =
  'Workflow status checklist (Phase-5): Workflows shell + tabs crash-check, Run-tree empty-DB degrade, workflow-steps API graceful degradation (missing/non-workflow/malformed run id), bogus deep-link resilience, and the populated-checklist observability gap (no-dispatch budget).'

const findings: Finding[] = []
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

/** A screenshot that never throws — a crashed/closed page must not abort the run. */
async function safeShot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* page/context closed — ignore */
  }
}

// ===========================================================================
// 1. Workflows shell + both tabs render (module-eval crash check)
// ===========================================================================

test('workflows shell boots with WS green and both tabs render (no crash)', async ({ page }) => {
  // Warm up (one-time Vite dep-optimize), then time the warm nav.
  await gotoApp(page, '#/workflows')
  const { ms } = await timed(() => gotoApp(page, '#/workflows'))
  await screenshot(page, 'P11-workflows-shell')

  try {
    // The two tab buttons must be present (Defined workflow / Run tree).
    await expect(page.getByRole('button', { name: 'Defined workflow' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Run tree' })).toBeVisible({ timeout: 10_000 })
    // Page heading. ("Workflows" also appears as the TopBar active-view label, so
    // match the first heading — its presence proves the shell rendered.)
    await expect(page.getByRole('heading', { name: 'Workflows' }).first()).toBeVisible()
  } catch (e) {
    findings.push({
      title: 'Workflows page did not render its tabs/heading',
      severity: 'High',
      category: 'Bug',
      surface: 'Workflows / WorkflowsPage',
      repro: 'Navigate to #/workflows and look for the Defined/Run-tree tabs and the heading.',
      expected: 'Workflows shell renders with both tabs and the "Workflows" heading.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P11-workflows-shell.png',
    })
  }

  if (ms > 5000) {
    findings.push({
      title: 'Workflows view is slow to become interactive',
      severity: 'Med',
      category: 'Perf',
      surface: 'Workflows',
      repro: 'Navigate to #/workflows (warm) and wait for WS + tabs.',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${ms}ms.`,
      evidence: 'reports/screens/P11-workflows-shell.png; harness.timed().',
    })
  }
})

// ===========================================================================
// 2. Run-tree tab degrades gracefully on a fresh (empty) DB
// ===========================================================================

test('run-tree tab degrades gracefully with no runs (no checklist, clear empty state)', async ({ page }) => {
  await gotoApp(page, '#/workflows')
  try {
    await page.getByRole('button', { name: 'Run tree' }).click()
    await page.waitForTimeout(600) // let the runs query settle
    await screenshot(page, 'P11-run-tree-empty')

    // On a fresh isolated DB there are no runs: the section shows "No runs yet."
    // and the run picker placeholder. The checklist must be ABSENT (it only
    // mounts once a delegation-workflow run is selected).
    const emptyMsg = page.getByText(/No runs yet\./i)
    const picker = page.locator('#wf-run-picker')
    const emptyVisible = await emptyMsg.isVisible({ timeout: 6_000 }).catch(() => false)
    const pickerVisible = await picker.isVisible().catch(() => false)

    if (!emptyVisible && !pickerVisible) {
      findings.push({
        title: 'Run-tree tab shows neither the empty-state message nor the run picker',
        severity: 'Med',
        category: 'UX',
        surface: 'Workflows / RunTreeSection',
        repro: 'Fresh DB (no runs) → #/workflows → "Run tree" tab.',
        expected: 'A "No runs yet." empty state and/or the run picker render gracefully.',
        actual: 'Neither the empty-state text nor #wf-run-picker was visible.',
        evidence: 'reports/screens/P11-run-tree-empty.png',
      })
    }

    // The explicit checklist component must not appear with no selected run.
    const checklist = page.locator('[data-testid="wf-checklist"]')
    if (await checklist.isVisible().catch(() => false)) {
      findings.push({
        title: 'Workflow checklist renders with no run selected',
        severity: 'Low',
        category: 'Bug',
        surface: 'Workflows / WorkflowChecklist',
        repro: 'Fresh DB → #/workflows → Run tree (no run selected).',
        expected: 'wf-checklist is omitted until a delegation-workflow run is selected.',
        actual: 'wf-checklist was visible with no selected run.',
        evidence: 'reports/screens/P11-run-tree-empty.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Run-tree tab crashed on an empty DB',
      severity: 'High',
      category: 'Bug',
      surface: 'Workflows / RunTreeSection',
      repro: 'Fresh DB → #/workflows → click "Run tree".',
      expected: 'Graceful empty state; no crash.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P11-run-tree-empty.png',
    })
  }
})

// ===========================================================================
// 3. workflow-steps API: graceful degradation for missing / malformed run id
//    This is the exact data path that feeds the checklist — the UI relies on
//    {workflowRun:null, steps:[]} to cleanly omit the panel. Hammer it.
// ===========================================================================

test('workflow-steps API degrades gracefully (missing/non-workflow/malformed run id → 200, never 500)', async ({ page }) => {
  // page.request is auto-authenticated via the Vite /api proxy (injects the dev
  // Bearer token), so these hit core directly.
  await gotoApp(page, '#/workflows')

  // Raw ids — each is encodeURIComponent'd so it reaches core as ONE literal
  // :id segment (an un-encoded "../.." would be URL-normalized away and never
  // reach the core route).
  const ids: Array<{ id: string; note: string }> = [
    { id: 'does-not-exist-0000', note: 'unknown run id' },
    { id: '../../etc/passwd', note: 'path-traversal-ish id' },
    { id: 'weird id\'" <tag>&%', note: 'special-chars id (space/quote/tag/percent)' },
    { id: 'a'.repeat(2000), note: 'oversized id' },
  ]

  for (const c of ids) {
    try {
      const res = await page.request.get(`/api/runs/${encodeURIComponent(c.id)}/workflow-steps`)
      const status = res.status()
      // Contract: a non-delegation / unknown run returns 200 {workflowRun:null, steps:[]}.
      // A defensive 400/404 is also acceptable; a 5xx is the failure.
      if (status >= 500) {
        findings.push({
          title: `workflow-steps API 5xx for ${c.note}`,
          severity: 'High',
          category: 'Bug',
          surface: 'core /api/runs/:id/workflow-steps',
          repro: `GET /api/runs/${c.id.slice(0, 40)}…/workflow-steps`,
          expected: '200 {workflowRun:null, steps:[]} (or a defensive 4xx) — never a 500.',
          actual: `HTTP ${status}.`,
          evidence: 'page.request capture',
        })
        continue
      }
      if (status === 200) {
        const body = (await res.json().catch(() => null)) as
          | { workflowRun?: unknown; steps?: unknown }
          | null
        const shapeOk =
          !!body &&
          'workflowRun' in body &&
          'steps' in body &&
          Array.isArray(body.steps)
        if (!shapeOk) {
          findings.push({
            title: `workflow-steps API 200 with an unexpected body shape (${c.note})`,
            severity: 'Med',
            category: 'Bug',
            surface: 'core /api/runs/:id/workflow-steps',
            repro: `GET /api/runs/${c.id.slice(0, 40)}…/workflow-steps`,
            expected: '{ workflowRun: <obj|null>, steps: [] } so the UI can omit the panel.',
            actual: `Body: ${JSON.stringify(body)?.slice(0, 200)}`,
            evidence: 'page.request capture',
          })
        } else if (body.workflowRun !== null) {
          findings.push({
            title: `workflow-steps API returned a non-null workflowRun for a bogus id (${c.note})`,
            severity: 'Low',
            category: 'Bug',
            surface: 'core /api/runs/:id/workflow-steps',
            repro: `GET /api/runs/${c.id.slice(0, 40)}…/workflow-steps`,
            expected: 'workflowRun:null for an unknown/non-delegation run id.',
            actual: `workflowRun=${JSON.stringify(body.workflowRun)?.slice(0, 160)}`,
            evidence: 'page.request capture',
          })
        }
      }
    } catch (e) {
      findings.push({
        title: `workflow-steps API request threw for ${c.note}`,
        severity: 'Med',
        category: 'Bug',
        surface: 'core /api/runs/:id/workflow-steps',
        repro: `GET /api/runs/${c.id.slice(0, 40)}…/workflow-steps`,
        expected: 'A clean HTTP response (200/4xx), no transport error.',
        actual: String(e).slice(0, 250),
        evidence: 'page.request capture',
      })
    }
  }
})

// ===========================================================================
// 4. Deep-link to a bogus run (#/workflows/<id>) must not crash the page
// ===========================================================================

test('deep-link to a bogus run id renders the run-tree without crashing; checklist omitted', async ({ page }) => {
  try {
    await gotoApp(page, '#/workflows/bogus-run-id-deadbeef')
    await page.waitForTimeout(800)
    await screenshot(page, 'P11-deeplink-bogus')

    // WS must still be green (hard reachability requirement is gotoApp's job).
    await waitForWs(page)

    // The checklist must be omitted (no workflow_run for a bogus id).
    const checklist = page.locator('[data-testid="wf-checklist"]')
    const checklistVisible = await checklist.isVisible({ timeout: 2_000 }).catch(() => false)
    if (checklistVisible) {
      findings.push({
        title: 'Workflow checklist rendered for a bogus deep-linked run id',
        severity: 'Med',
        category: 'Bug',
        surface: 'Workflows / WorkflowChecklist',
        repro: 'Navigate to #/workflows/bogus-run-id-deadbeef.',
        expected: 'workflow-steps returns workflowRun:null → the checklist panel is omitted.',
        actual: 'wf-checklist was visible for a run id that does not exist.',
        evidence: 'reports/screens/P11-deeplink-bogus.png',
      })
    }

    // The shell must remain interactive (sidebar present).
    await expect(page.getByRole('button', { name: 'Home' })).toBeVisible()
  } catch (e) {
    findings.push({
      title: 'Bogus workflow deep-link crashed the page',
      severity: 'High',
      category: 'Bug',
      surface: 'Workflows / deep-link',
      repro: 'Navigate to #/workflows/bogus-run-id-deadbeef.',
      expected: 'Graceful render (empty run tree, no checklist); shell intact.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P11-deeplink-bogus.png',
    })
  }
})

// ===========================================================================
// 5. Observability gap: the populated checklist can't be verified without a
//    real delegation-workflow dispatch. Record it precisely (not a defect of
//    the component, but a real testability/observability gap a staff reviewer
//    should see).
// ===========================================================================

test('populated checklist rendering is unverifiable within the no-dispatch budget (observability gap)', async ({ page }) => {
  // Document the component contract we COULD verify if a workflow_run existed:
  //   • status glyphs: pending ○ / in_progress ◐ / done ● / blocked ◼ / failed ✕
  //   • kind badges: task→"ticket", phase→"phase", review→"review", ci→"CI"
  //   • done rows are struck-through; wf-overall-status mirrors workflowRun.status
  //   • empty branch (wf-checklist-empty "No status reported yet.") only renders
  //     when a workflow_run exists but has zero steps.
  // None of these mount without a workflow_run, which is created ONLY by a real
  // multi-agent dispatch (dispatchTaskWorkflow) or the kstore stdio MCP tools.
  await gotoApp(page, '#/workflows')
  await screenshot(page, 'P11-checklist-gap')

  findings.push({
    title: 'Workflow checklist populated state has no token-free way to preview/verify',
    severity: 'Low',
    category: 'Missing',
    surface: 'Workflows / WorkflowChecklist',
    repro:
      'Try to render wf-checklist (status glyphs, kind badges, overall status) without firing a real ' +
      'multi-agent dispatch. There is no HTTP seed route, no demo/sample workflow run, and the only ' +
      'writers are dispatchTaskWorkflow (real dispatch) and the kstore stdio MCP tools.',
    expected:
      'A way to preview the explicit progress checklist (e.g. a seeded sample workflow run, a demo ' +
      'fixture, or an HTTP create endpoint) so its populated rendering is verifiable without spending tokens.',
    actual:
      'wf-checklist only mounts when GET /api/runs/:id/workflow-steps returns a non-null workflowRun, ' +
      'which requires a real delegation-workflow run. Within the no-dispatch persona budget the populated ' +
      'checklist (glyphs/badges/overall-status/line-through) is untested; only the empty/degraded paths are covered.',
    evidence: 'web/src/components/WorkflowChecklist.tsx; web/src/pages/WorkflowsPage.tsx (wf?.workflowRun gate).',
  })
})

// ===========================================================================
// Fail-loud: console / page errors → findings (run after every test)
// ===========================================================================

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during the workflow-checklist flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Workflows / P11',
      repro: 'Drive the workflow-checklist surfaces with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    // The bogus-deep-link + bogus-id API probes deliberately 404 the run fetch;
    // the browser still console.errors the raw resource load. Filter that noise
    // plus Vite HMR/websocket chatter so only app-level errors are flagged.
    const real = sink.errors.filter(
      e =>
        !/favicon|\[vite\]|hot-update|websocket|ws:\/\//i.test(e) &&
        !/failed to load resource.*\b4\d\d\b/i.test(e),
    )
    if (real.length) {
      findings.push({
        title: 'console.error logged during the workflow-checklist flow',
        severity: 'High',
        category: 'Bug',
        surface: 'Workflows / P11',
        repro: 'Drive the workflow-checklist surfaces with the console attached.',
        expected: 'No app-level console.error (expected 4xx/HMR noise excluded).',
        actual: real.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  try {
    writeFindings('P11', CHARTER, findings)
  } catch {
    /* last-ditch: nothing more we can do */
  }
})

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
// P07 — Metrics & Routing Analyst
// Charter: Metrics (#/metrics) timeseries chart across every groupBy ×
// days × metric combination; Routing (#/routing) provider/model breakdown;
// empty/low-data rendering (fresh stack, no run data) — assert empty states
// are graceful (no NaN, no blank canvas, no infinite spinner, sane axes);
// time view switches + filter changes (flag jank/refetch storms/missing
// loading feedback); cross-check Home metric-card numbers vs Metrics page.
//
// Adversarial: this is a FRESH stack with little/no run data, so the primary
// focus is empty/low-data rendering. Every interaction is wrapped so one
// broken surface never aborts the run before writeFindings().
// ===========================================================================

const CHARTER =
  'Metrics & Routing: timeseries chart across groupBy/days/metric combos, routing breakdown, empty/low-data rendering, view-switch timing, Home↔Metrics consistency.'
const findings: Finding[] = []
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// Helper: record a thrown error as a finding instead of failing the run.
function recordThrow(title: string, surface: string, err: unknown, evidence = '') {
  findings.push({
    title,
    severity: 'High',
    category: 'Bug',
    surface,
    repro: 'See spec P07; interaction threw before assertions could complete.',
    expected: 'Interaction completes without throwing.',
    actual: String((err as Error)?.stack ?? err).slice(0, 800),
    evidence: evidence || 'try/catch in P07.spec.ts',
  })
}

// ---------------------------------------------------------------------------
// Metrics page: every groupBy × days × metric combination renders.
// ---------------------------------------------------------------------------
test('Metrics chart renders across every filter combination', async ({ page }) => {
  // Warm up Vite dep-optimize on the first nav so timings below are warm.
  await gotoApp(page, '#/metrics')
  const { ms: warmMs } = await timed(() => gotoApp(page, '#/metrics'))

  // Scope to the page's <main> landmark so SegControl buttons ("Runs", "Tokens"…)
  // never collide with the icon-only sidebar nav (which also has a "Runs" button).
  const main = page.getByRole('main')

  // Controls present (SegControl buttons by visible text).
  try {
    await expect(main.getByRole('button', { name: 'By Project' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'By Model' })).toBeVisible()
    await expect(main.getByRole('button', { name: '14d' })).toBeVisible()
    await expect(main.getByRole('button', { name: '30d' })).toBeVisible()
    await expect(main.getByRole('button', { name: '60d' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Tokens' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Cost' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Runs' })).toBeVisible()
  } catch (err) {
    recordThrow('Metrics controls not all visible', 'Metrics', err, 'reports/screens/P07-metrics-controls.png')
    await screenshot(page, 'P07-metrics-controls')
  }

  if (warmMs > 5000) {
    findings.push({
      title: 'Metrics page warm load is slow',
      severity: 'Med',
      category: 'Perf',
      surface: 'Metrics',
      repro: 'Navigate to #/metrics (warm, after first dep-optimize).',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${warmMs}ms to reach WS-connected.`,
      evidence: 'harness.timed()',
    })
  }

  const groupBys = [
    { label: 'By Project', value: 'project' },
    { label: 'By Model', value: 'model' },
  ]
  const dayOpts = ['14d', '30d', '60d']
  const metrics = ['Tokens', 'Cost', 'Runs']

  // The chart card contains either a real <svg role="img"> or the inline
  // "no runs in window" empty state — never a blank/NaN canvas.
  let combo = 0
  let slowCombos = 0
  let maxComboMs = 0
  for (const gb of groupBys) {
    for (const d of dayOpts) {
      for (const m of metrics) {
        combo++
        try {
          const { ms } = await timed(async () => {
            await main.getByRole('button', { name: gb.label, exact: true }).click()
            await main.getByRole('button', { name: d, exact: true }).click()
            await main.getByRole('button', { name: m, exact: true }).click()
            // Settle: either the chart svg or the inline empty state must show.
            await expect(
              main.locator('svg[role="img"]').or(main.getByText('no runs in window')).first()
            ).toBeVisible({ timeout: 10_000 })
          })
          maxComboMs = Math.max(maxComboMs, ms)
          if (ms > 1500) slowCombos++

          // Empty-state guard: no NaN / no "undefined" / no "Infinity" anywhere
          // in the chart card text (these would mean a broken scale on no data).
          const bodyText = await page.locator('body').innerText()
          for (const bad of ['NaN', 'Infinity', 'undefined', '$NaN', 'undefinedk']) {
            if (bodyText.includes(bad)) {
              findings.push({
                title: `Garbage value "${bad}" rendered on Metrics`,
                severity: 'High',
                category: 'Bug',
                surface: `Metrics (${gb.label} / ${d} / ${m})`,
                repro: `#/metrics → set groupBy=${gb.value}, days=${d}, metric=${m}.`,
                expected: 'No NaN/Infinity/undefined in any rendered value (graceful empty state).',
                actual: `Found "${bad}" in page text.`,
                evidence: `reports/screens/P07-metrics-${gb.value}-${d}-${m}.png`,
              })
              await screenshot(page, `P07-metrics-${gb.value}-${d}-${m}`)
            }
          }

          // "max <value>" annotation should always be present and finite.
          const maxAnno = await main.getByText(/^max\s+/).first().textContent().catch(() => null)
          if (maxAnno && /max\s+(NaN|Infinity|undefined|—)/.test(maxAnno)) {
            findings.push({
              title: 'Chart "max" annotation is not a finite value',
              severity: 'Med',
              category: 'Bug',
              surface: `Metrics (${gb.label} / ${d} / ${m})`,
              repro: `#/metrics → groupBy=${gb.value}, days=${d}, metric=${m}.`,
              expected: 'max annotation shows a finite number (e.g. "max 0" or "max 1").',
              actual: `Annotation read: "${maxAnno}".`,
              evidence: 'TimeseriesChart max annotation',
            })
          }
        } catch (err) {
          recordThrow(
            `Metrics combo failed (${gb.label}/${d}/${m})`,
            `Metrics (${gb.label}/${d}/${m})`,
            err,
            `reports/screens/P07-metrics-fail-${gb.value}-${d}-${m}.png`
          )
          await screenshot(page, `P07-metrics-fail-${gb.value}-${d}-${m}`)
        }
      }
    }
  }

  await screenshot(page, 'P07-metrics-final')

  if (slowCombos > 0) {
    findings.push({
      title: 'Some Metrics filter changes lack fast feedback',
      severity: 'Low',
      category: 'Perf',
      surface: 'Metrics',
      repro: 'Toggle groupBy/days/metric across all 18 combinations and time each.',
      expected: 'Filter change settles <1.5s (keepPreviousData should avoid flashes).',
      actual: `${slowCombos}/${combo} combos took >1.5s; slowest ${maxComboMs}ms.`,
      evidence: 'harness.timed() per combo',
    })
  }
})

// ---------------------------------------------------------------------------
// Date-axis label crowding: the last two ticks must not overprint at the
// right edge. TimeseriesChart picks ticks at 0,7,14,21,28,… plus n-1; when
// (n-1) sits one slot after the last weekly tick (e.g. 30d → ticks 28 & 29),
// the centered tick and the right-anchored last tick collide into a single
// run of text. Caught visually first (06/21 + 06/22 → "06/2106/22").
// ---------------------------------------------------------------------------
test('Metrics date-axis ticks do not overlap at the right edge', async ({ page }) => {
  await gotoApp(page, '#/metrics')
  const main = page.getByRole('main')
  try {
    // 30d window is the worst case (ticks 28 & 29 are calendar-adjacent).
    await main.getByRole('button', { name: '30d', exact: true }).click()
    await expect(
      main.locator('svg[role="img"]').or(main.getByText('no runs in window')).first()
    ).toBeVisible({ timeout: 8_000 })

    // Read the axis tick labels (mono spans below the chart).
    const labels = (await main.locator('span.mono.absolute').allInnerTexts())
      .map(s => s.trim())
      .filter(Boolean)

    // Parse MM/DD; flag when the last two ticks are <=1 calendar day apart,
    // which is the overlap condition (they share the same right-edge pixels).
    const toDay = (s: string): number | null => {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})$/)
      if (!m) return null
      return Number(m[1]) * 31 + Number(m[2]) // monotonic within a month-ish ordinal
    }
    if (labels.length >= 2) {
      const a = toDay(labels[labels.length - 2])
      const b = toDay(labels[labels.length - 1])
      if (a !== null && b !== null && b - a >= 0 && b - a <= 1) {
        findings.push({
          title: 'Metrics date-axis labels overlap at the right edge (30d)',
          severity: 'Low',
          category: 'UX',
          surface: 'Metrics / TimeseriesChart date axis',
          repro: '#/metrics → 30d window → inspect the rightmost two date ticks.',
          expected: 'Adjacent ticks are spaced/anchored so they never overprint.',
          actual: `Last two ticks "${labels[labels.length - 2]}" and "${labels[labels.length - 1]}" are calendar-adjacent and render on top of each other (e.g. "06/2106/22"). The penultimate tick uses translateX(-50%) while the last uses translateX(-100%), so at n-1≡1 (mod 7) they collide.`,
          evidence: 'reports/screens/P07-metrics-axis-30d.png',
        })
      }
    }
    await screenshot(page, 'P07-metrics-axis-30d')
  } catch (err) {
    recordThrow('Metrics axis-overlap check failed', 'Metrics', err)
  }
})

// ---------------------------------------------------------------------------
// Metrics empty-state: with no data the chart must show a graceful empty
// state (the inline "no runs in window"), not a blank canvas or spinner.
// ---------------------------------------------------------------------------
test('Metrics empty state is graceful (no blank canvas / infinite spinner)', async ({ page }) => {
  await gotoApp(page, '#/metrics')
  try {
    // Give the query up to its window to resolve; loading text must NOT persist.
    const loading = page.getByText('loading…', { exact: true })
    await expect(loading).toHaveCount(0, { timeout: 10_000 }).catch(() => {})

    const stillLoading = await loading.isVisible().catch(() => false)
    if (stillLoading) {
      findings.push({
        title: 'Metrics chart stuck on "loading…" (possible infinite spinner)',
        severity: 'High',
        category: 'Bug',
        surface: 'Metrics',
        repro: 'Fresh stack → #/metrics, wait 10s.',
        expected: 'Empty data resolves quickly to an empty state, not perpetual loading.',
        actual: 'loading… text still visible after 10s.',
        evidence: 'reports/screens/P07-metrics-loading.png',
      })
      await screenshot(page, 'P07-metrics-loading')
    }

    // On a fresh stack with zero runs we expect the inline empty state.
    const emptyState = page.getByText('no runs in window')
    const hasEmpty = await emptyState.isVisible().catch(() => false)
    const hasSvg = await page.getByRole('main').locator('svg[role="img"]').isVisible().catch(() => false)

    if (!hasEmpty && !hasSvg) {
      findings.push({
        title: 'Metrics chart shows neither data nor a labeled empty state',
        severity: 'High',
        category: 'UX',
        surface: 'Metrics',
        repro: 'Fresh stack → #/metrics.',
        expected: 'With no run data, show an explanatory empty state ("no runs in window").',
        actual: 'No empty-state text and no chart svg rendered.',
        evidence: 'reports/screens/P07-metrics-empty.png',
      })
    }
    await screenshot(page, 'P07-metrics-empty')
  } catch (err) {
    recordThrow('Metrics empty-state check failed', 'Metrics', err)
  }
})

// ---------------------------------------------------------------------------
// Routing page: provider/model breakdown + empty state + recommendation.
// ---------------------------------------------------------------------------
test('Routing renders recommendation + empty breakdown gracefully', async ({ page }) => {
  await gotoApp(page, '#/routing')

  const main = page.getByRole('main')
  try {
    // The TopBar also renders "⇄Routing"; scope to the page <main> + exact match.
    await expect(main.getByRole('heading', { name: 'Routing', exact: true })).toBeVisible({ timeout: 10_000 })

    // Recommendation banner always renders once routing data resolves.
    const reco = page.getByText('Recommendation', { exact: true })
    const hasReco = await reco.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasReco) {
      findings.push({
        title: 'Routing recommendation banner did not render',
        severity: 'High',
        category: 'Bug',
        surface: 'Routing',
        repro: 'Fresh stack → #/routing.',
        expected: 'Recommendation banner shows (e.g. "Not enough run history yet…").',
        actual: 'Recommendation banner not visible after 10s.',
        evidence: 'reports/screens/P07-routing-empty.png',
      })
    } else {
      // The recommendation text for an empty stack should be the no-history copy.
      const recoText = await page.locator('p.text-sm').first().textContent().catch(() => '')
      if (recoText && /(NaN|undefined|Infinity)/.test(recoText)) {
        findings.push({
          title: 'Routing recommendation contains a garbage value',
          severity: 'High',
          category: 'Bug',
          surface: 'Routing',
          repro: 'Fresh stack → #/routing.',
          expected: 'Recommendation is plain language, no NaN/undefined.',
          actual: `Recommendation read: "${recoText}".`,
          evidence: 'Routing recommendation banner',
        })
      }
    }

    // Empty breakdown: the "No run history yet" state should show (no table).
    const emptyBreakdown = page.getByText(/No run history yet/i)
    const hasEmptyBreakdown = await emptyBreakdown.isVisible().catch(() => false)
    const hasTable = await page.locator('table').isVisible().catch(() => false)

    if (!hasEmptyBreakdown && !hasTable) {
      findings.push({
        title: 'Routing breakdown shows neither table nor empty state',
        severity: 'Med',
        category: 'UX',
        surface: 'Routing',
        repro: 'Fresh stack → #/routing.',
        expected: 'With no routing data, show "No run history yet" empty state.',
        actual: 'No per-model table and no empty-state text.',
        evidence: 'reports/screens/P07-routing-empty.png',
      })
    }

    // If a table somehow exists, guard against NaN/— in numeric cells.
    if (hasTable) {
      const tableText = await page.locator('table').innerText()
      if (/NaN|Infinity|undefined/.test(tableText)) {
        findings.push({
          title: 'Routing table contains garbage numeric values',
          severity: 'High',
          category: 'Bug',
          surface: 'Routing',
          repro: '#/routing with run data.',
          expected: 'All numeric cells formatted (formatCost/formatLatency/formatSuccessRate).',
          actual: 'Found NaN/Infinity/undefined in table.',
          evidence: 'Routing per-model table',
        })
      }
    }

    await screenshot(page, 'P07-routing-empty')
  } catch (err) {
    recordThrow('Routing page check failed', 'Routing', err, 'reports/screens/P07-routing-fail.png')
    await screenshot(page, 'P07-routing-fail')
  }

  // Day-filter changes on Routing.
  for (const d of ['14d', '30d', '60d']) {
    try {
      const { ms } = await timed(async () => {
        await main.getByRole('button', { name: d, exact: true }).click()
        await expect(page.getByText('Recommendation', { exact: true })).toBeVisible({ timeout: 8_000 })
      })
      if (ms > 1500) {
        findings.push({
          title: `Routing day filter "${d}" change slow / no feedback`,
          severity: 'Low',
          category: 'Perf',
          surface: 'Routing',
          repro: `#/routing → click ${d}.`,
          expected: 'Settles <1.5s (keepPreviousData avoids flash).',
          actual: `Took ${ms}ms.`,
          evidence: 'harness.timed()',
        })
      }
    } catch (err) {
      recordThrow(`Routing day filter ${d} failed`, 'Routing', err)
    }
  }
})

// ---------------------------------------------------------------------------
// Cross-check: Home metric cards vs Metrics page should be internally
// consistent (both read from the same runs DB). On a fresh stack both should
// reflect zero. Flag any contradiction (e.g. Home shows runs, Metrics empty).
// ---------------------------------------------------------------------------
test('Home metric cards are consistent with Metrics page (no data)', async ({ page }) => {
  await gotoApp(page, '#/home')
  try {
    const main = page.getByRole('main')
    await expect(main.getByText('Total runs')).toBeVisible({ timeout: 10_000 })

    // Read a MetricCard value: the card is the nearest ancestor of the label
    // span that also holds the mono value span. We grab the card's full text
    // and strip the label to isolate the rendered value.
    const readCard = async (label: string): Promise<string> => {
      const card = main.locator('div.card-lift').filter({ hasText: label }).first()
      const txt = await card.innerText().catch(() => '')
      const m = txt.replace(label, '').match(/[\d.,$kM—]+/)
      return (m?.[0] ?? '').trim()
    }
    const totalRuns = await readCard('Total runs')
    const runsToday = await readCard('Runs today')
    const tokensToday = await readCard('Tokens today')

    // No NaN/undefined on the cards.
    for (const [label, v] of [['Total runs', totalRuns], ['Runs today', runsToday], ['Tokens today', tokensToday]] as const) {
      if (/NaN|undefined|Infinity/.test(v)) {
        findings.push({
          title: `Home metric card "${label}" shows a garbage value`,
          severity: 'High',
          category: 'Bug',
          surface: 'Home / MetricCard',
          repro: 'Fresh stack → #/home.',
          expected: 'Numeric cards show 0 / "—" / formatted number, never NaN.',
          actual: `${label} = "${v}".`,
          evidence: 'reports/screens/P07-home-cards.png',
        })
      }
    }
    await screenshot(page, 'P07-home-cards')

    // Now go to Metrics and confirm the empty-state agreement: if Home shows
    // 0 total runs, Metrics should show the "no runs in window" empty state.
    await gotoApp(page, '#/metrics')
    const metricsMain = page.getByRole('main')
    await metricsMain.getByRole('button', { name: 'Runs', exact: true }).click().catch(() => {})
    const metricsEmpty = await metricsMain
      .getByText('no runs in window')
      .isVisible({ timeout: 8_000 })
      .catch(() => false)

    const totalRunsNum = Number(totalRuns.replace(/[^\d]/g, '') || '0')
    if (totalRunsNum === 0 && !metricsEmpty) {
      const hasSvg = await metricsMain.locator('svg[role="img"]').isVisible().catch(() => false)
      if (!hasSvg) {
        findings.push({
          title: 'Home reports 0 runs but Metrics chart shows neither data nor empty state',
          severity: 'Med',
          category: 'UX',
          surface: 'Home ↔ Metrics',
          repro: 'Fresh stack → read Home Total runs (0) → #/metrics.',
          expected: 'Consistent: Metrics shows the "no runs in window" empty state.',
          actual: 'No empty-state text and no chart on Metrics.',
          evidence: 'reports/screens/P07-consistency.png',
        })
      }
    }
    // Inverse contradiction: Home shows runs but Metrics claims empty.
    if (totalRunsNum > 0 && metricsEmpty) {
      findings.push({
        title: 'Home shows runs but Metrics chart claims "no runs in window"',
        severity: 'Med',
        category: 'Bug',
        surface: 'Home ↔ Metrics',
        repro: `Fresh stack → Home Total runs=${totalRunsNum} → #/metrics (Runs, 30d).`,
        expected: 'If lifetime runs > 0, the 30d window typically shows data.',
        actual: 'Metrics shows the empty state despite Home reporting runs (note: lifetime vs 30d window may legitimately differ).',
        evidence: 'reports/screens/P07-consistency.png',
      })
    }
    await screenshot(page, 'P07-consistency')
  } catch (err) {
    recordThrow('Home↔Metrics consistency check failed', 'Home ↔ Metrics', err)
  }
})

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error on a Metrics/Routing surface',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Metrics / Routing',
      repro: 'Drive the metrics/routing flows with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
    sink.pageErrors = []
  }
  if (sink?.errors.length) {
    findings.push({
      title: 'console.error logged on a Metrics/Routing surface',
      severity: 'High',
      category: 'Bug',
      surface: 'Metrics / Routing',
      repro: 'Drive the metrics/routing flows with the console attached.',
      expected: 'No console.error in a clean session.',
      actual: sink.errors.join('\n').slice(0, 800),
      evidence: 'page.on("console") capture',
    })
    sink.errors = []
  }
})

test.afterAll(() => {
  writeFindings('P07', CHARTER, findings)
})

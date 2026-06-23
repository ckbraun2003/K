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

// ===========================================================================
// P08 — Navigation & Keyboard Power User
// Charter (adversarial; navigation correctness + keyboard affordances):
//  - Visit every ENABLED sidebar destination; assert it loads w/o error and the
//    active state + TopBar title update. Confirm Tasks + Settings are DISABLED.
//  - Keyboard chords: `g` then `h/p/r/d/m`; record conflicts / dead chords /
//    typing-in-input leakage.
//  - ⌘K dual mode: NAVIGATES (nav target) AND DISPATCHES (prompt) — flag
//    ambiguity between the two.
//  - Hash deep-links: goto #/metrics, #/docs/project-bible, #/runs directly.
//    Try an UNKNOWN route (#/nonsense) and record the behavior.
//  - Browser back/forward across navigations; full reload on a deep route.
//  - WS reconnect indicator (status dot) behavior.
//
//  Do NOT dispatch agent runs. Do NOT modify app source.
// ===========================================================================

const CHARTER =
  'Navigation & keyboard power user: every enabled sidebar destination loads + updates active state/TopBar title; Tasks/Settings disabled; g-chord jumps; ⌘K navigate-vs-dispatch ambiguity; hash deep-links + unknown route; back/forward + reload persistence; WS status dot.'
const findings: Finding[] = []
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

function add(f: Finding) {
  findings.push(f)
}

/** Screenshot that can never abort a test (full-page shots flake under animation). */
async function shot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* best-effort evidence only */
  }
}

/** Read the TopBar title text (the <h1>). */
async function topBarTitle(page: Page): Promise<string> {
  return (await page.locator('header h1').first().innerText().catch(() => '')).trim()
}

/** Open ⌘K resiliently: first ensure any prior palette overlay has fully
 *  unmounted (AnimatePresence keeps the backdrop briefly, which intercepts the
 *  TopBar button click), then open and wait for the input. */
async function openBar(page: Page): Promise<void> {
  // If a palette is open/closing, dismiss it and wait for the backdrop to go.
  await page.keyboard.press('Escape').catch(() => {})
  await page
    .locator('.fixed.inset-0.z-50')
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})
  await openCommandBar(page)
  await expect(page.getByPlaceholder(/Ask K/i)).toBeVisible({ timeout: 8000 })
}

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// ---------------------------------------------------------------------------
// 1. Every ENABLED sidebar destination loads, updates active state + TopBar.
//    Help is special: it deep-links into docs/project-bible (view=docs).
// ---------------------------------------------------------------------------
test('every enabled sidebar destination loads + updates active state/TopBar', async ({ page }) => {
  await gotoApp(page, '#/home')
  // warm nav so the one-time Vite optimize cost isn't blamed on a destination
  await gotoApp(page, '#/home')

  // label → { expectedView for the route, expectedTitle in the TopBar }
  // Help routes to docs (view override) so its expected view is 'docs'.
  const dests: Array<{ label: string; view: string; title: string; chord?: string }> = [
    { label: 'Home', view: 'home', title: 'Home' },
    { label: 'Projects', view: 'projects', title: 'Projects' },
    { label: 'Fleet Graph', view: 'graph', title: 'Fleet Graph' },
    { label: 'Runs', view: 'runs', title: 'Runs' },
    { label: 'Skills', view: 'skills', title: 'Skills' },
    { label: 'Metrics', view: 'metrics', title: 'Metrics' },
    { label: 'Routing', view: 'routing', title: 'Routing' },
    { label: 'Terminal', view: 'terminal', title: 'Terminal' },
    { label: 'Docs', view: 'docs', title: 'Docs' },
    { label: 'Help', view: 'docs', title: 'Docs' }, // deep-links to docs/project-bible
  ]

  for (const d of dests) {
    try {
      const btn = page.getByRole('button', { name: d.label, exact: true })
      await expect(btn).toBeVisible({ timeout: 8000 })
      const { ms } = await timed(async () => {
        await btn.click()
        await page.waitForURL(new RegExp(`#/${d.view}`), { timeout: 10_000 })
      })
      await waitForWs(page)

      // TopBar title should reflect the destination.
      const title = await topBarTitle(page)
      if (!new RegExp(d.title, 'i').test(title)) {
        add({
          title: `TopBar title wrong after navigating to "${d.label}"`,
          severity: 'Med',
          category: 'Bug',
          surface: `Sidebar ${d.label} / TopBar`,
          repro: `Click the "${d.label}" sidebar button.`,
          expected: `TopBar <h1> shows "${d.title}".`,
          actual: `TopBar showed "${title}".`,
          evidence: `reports/screens/P08-nav-${d.view}.png`,
        })
      }

      // Active state: aria-current="page" should be set on a sidebar button.
      // NOTE: the Sidebar sets aria-current on the button whose (view ?? id)
      // matches the active view, but applies the HIGHLIGHT class on id===view.
      // For Help (view=docs) that means the DOCS button (not Help) is the one
      // that lights up — captured as its own finding below.
      const current = page.locator('nav button[aria-current="page"]')
      const currentCount = await current.count()
      if (currentCount === 0) {
        add({
          title: `No sidebar button marked active (aria-current) on "${d.label}"`,
          severity: 'Med',
          category: 'UX',
          surface: `Sidebar ${d.label}`,
          repro: `Navigate to ${d.label}; inspect the sidebar for aria-current="page".`,
          expected: 'Exactly one sidebar entry carries aria-current="page".',
          actual: 'No nav button had aria-current="page".',
          evidence: `reports/screens/P08-nav-${d.view}.png`,
        })
      }

      await shot(page, `P08-nav-${d.view}`)
      if (ms > 5000) {
        add({
          title: `Navigation to "${d.label}" is slow`,
          severity: 'Low',
          category: 'Perf',
          surface: `Sidebar ${d.label}`,
          repro: `Click "${d.label}" and wait for the view + WS-connected.`,
          expected: 'View ready within a few seconds.',
          actual: `Took ${ms}ms.`,
          evidence: `reports/screens/P08-nav-${d.view}.png`,
        })
      }
    } catch (e) {
      add({
        title: `Sidebar destination "${d.label}" failed to load`,
        severity: 'High',
        category: 'Bug',
        surface: `Sidebar ${d.label}`,
        repro: `Click the "${d.label}" sidebar button from Home.`,
        expected: `Lands on #/${d.view} without error.`,
        actual: String(e).slice(0, 400),
        evidence: 'nav click / waitForURL threw',
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 2. Help/Docs active-state inconsistency (aria-current vs highlight class).
//    The Sidebar computes aria-current with (view ?? id)===active, but the
//    visual highlight class uses id===active. Help has view='docs', so after
//    clicking Help BOTH "Docs" gets the highlight class AND only the matching
//    aria-current entry lights up — Help itself never shows highlighted.
// ---------------------------------------------------------------------------
test('Help vs Docs active-state is internally consistent', async ({ page }) => {
  await gotoApp(page, '#/docs/project-bible')
  await waitForWs(page)
  try {
    const ariaCurrentLabels: string[] = []
    const currents = page.locator('nav button[aria-current="page"]')
    const n = await currents.count()
    for (let i = 0; i < n; i++) {
      ariaCurrentLabels.push((await currents.nth(i).getAttribute('aria-label')) ?? '')
    }
    // Both Help and Docs resolve to view=docs; aria-current is set for any entry
    // whose (view ?? id) === 'docs' → that is BOTH "Docs" and "Help".
    const both = ariaCurrentLabels.includes('Docs') && ariaCurrentLabels.includes('Help')
    if (both) {
      add({
        title: 'Two sidebar entries (Docs + Help) both report active on the bible route',
        severity: 'Low',
        category: 'UX',
        surface: 'Sidebar active-state',
        repro: 'Navigate to #/docs/project-bible (or click Help).',
        expected: 'Exactly one sidebar entry is the active/current page.',
        actual: `aria-current="page" set on: ${ariaCurrentLabels.join(', ')}. Help shares view=docs with Docs, so both light up as current.`,
        evidence: 'Sidebar.tsx: aria-current uses (view ?? id)===active for both Docs and Help.',
      })
    }
    await shot(page, 'P08-help-docs-active')
  } catch (e) {
    add({
      title: 'Could not evaluate Help/Docs active-state',
      severity: 'Nit',
      category: 'Bug',
      surface: 'Sidebar active-state',
      repro: 'Navigate to #/docs/project-bible and inspect aria-current.',
      expected: 'Inspectable active state.',
      actual: String(e).slice(0, 300),
      evidence: 'evaluation threw',
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Tasks + Settings are DISABLED — confirm and judge whether it's communicated.
// ---------------------------------------------------------------------------
test('Tasks and Settings are disabled (and reasonably communicated)', async ({ page }) => {
  await gotoApp(page, '#/home')
  for (const label of ['Tasks', 'Settings']) {
    try {
      const btn = page.getByRole('button', { name: label, exact: false }).first()
      await expect(btn).toBeVisible({ timeout: 6000 })
      const disabled = await btn.isDisabled().catch(() => false)
      const title = (await btn.getAttribute('title')) ?? ''
      if (!disabled) {
        add({
          title: `"${label}" is expected to be disabled but is enabled`,
          severity: 'Med',
          category: 'Bug',
          surface: `Sidebar ${label}`,
          repro: `Inspect the "${label}" sidebar button.`,
          expected: `${label} is disabled (Phase 1 — not yet implemented).`,
          actual: 'Button was not disabled.',
          evidence: 'isDisabled() === false',
        })
        continue
      }
      // Communicated? The disabled tooltip is just the bare label ("Tasks ·
      // Phase 1" / "Settings · Phase 1") — there is no hint string and no
      // visible "coming soon" affordance beyond the dimmed glyph + title.
      const communicates = /phase|soon|coming|not.*available|disabled/i.test(title)
      if (!communicates) {
        add({
          title: `Disabled "${label}" gives no reason why it's unavailable`,
          severity: 'Low',
          category: 'UX',
          surface: `Sidebar ${label}`,
          repro: `Hover the dimmed "${label}" icon.`,
          expected: 'Tooltip explains it is a future phase / coming soon.',
          actual: `Tooltip was "${title || '(empty)'}". A new operator only sees a dimmed glyph.`,
          evidence: 'getAttribute("title")',
        })
      } else {
        // It IS communicated (e.g. "· Phase 1"); record a Nit confirming so.
        add({
          title: `Disabled "${label}" is communicated via its tooltip`,
          severity: 'Nit',
          category: 'UX',
          surface: `Sidebar ${label}`,
          repro: `Hover the dimmed "${label}" icon.`,
          expected: 'Disabled state is explained.',
          actual: `Tooltip: "${title}". Reasonable — disabled state labeled with its phase.`,
          evidence: 'getAttribute("title")',
        })
      }
    } catch (e) {
      add({
        title: `Could not locate the "${label}" sidebar entry`,
        severity: 'Low',
        category: 'Missing',
        surface: `Sidebar ${label}`,
        repro: `Look for a "${label}" button in the sidebar.`,
        expected: `A disabled "${label}" entry exists.`,
        actual: String(e).slice(0, 300),
        evidence: 'getByRole threw',
      })
    }
  }
  await shot(page, 'P08-disabled-entries')
})

// ---------------------------------------------------------------------------
// 4. Keyboard chords: `g` then h/p/r/d/m. Record which work and which conflict.
// ---------------------------------------------------------------------------
test('g-chord jump-to-view works for h/p/r/d/m', async ({ page }) => {
  await gotoApp(page, '#/home')
  await waitForWs(page)

  const chords: Array<{ key: string; view: string; label: string }> = [
    { key: 'p', view: 'projects', label: 'Projects' },
    { key: 'r', view: 'runs', label: 'Runs' },
    { key: 'd', view: 'docs', label: 'Docs' },
    { key: 'm', view: 'metrics', label: 'Metrics' },
    { key: 'h', view: 'home', label: 'Home' },
  ]

  const worked: string[] = []
  const failed: string[] = []

  // Make sure focus is on the body (not an input) so the chord handler runs.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})

  for (const c of chords) {
    try {
      // Navigate away first so 'h' (home) is observable too.
      if (c.view === 'home') await gotoApp(page, '#/metrics')
      await page.keyboard.press('g')
      await page.keyboard.press(c.key)
      await page.waitForURL(new RegExp(`#/${c.view}\\b`), { timeout: 4000 })
      worked.push(`g ${c.key} → ${c.label}`)
    } catch {
      failed.push(`g ${c.key} → ${c.label}`)
    }
  }

  await shot(page, 'P08-chords')

  if (failed.length) {
    add({
      title: 'Some g-chord jump shortcuts did not navigate',
      severity: 'Med',
      category: 'Bug',
      surface: 'Shell keyboard chords',
      repro: 'With focus on the body, press "g" then one of h/p/r/d/m.',
      expected: 'All five chords jump to their views within the 800ms window.',
      actual: `Worked: [${worked.join(', ') || 'none'}]. Failed: [${failed.join(', ')}].`,
      evidence: 'reports/screens/P08-chords.png',
    })
  } else {
    add({
      title: 'All g-chord jump shortcuts work (g h/p/r/d/m)',
      severity: 'Nit',
      category: 'UX',
      surface: 'Shell keyboard chords',
      repro: 'Press "g" then h/p/r/d/m on the body.',
      expected: 'Each jumps to its view.',
      actual: `Worked: ${worked.join(', ')}.`,
      evidence: 'reports/screens/P08-chords.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 5. Chord coverage gap: enabled destinations with NO chord (graph, skills,
//    routing, terminal). Power-user expectation: parity or a discoverable map.
// ---------------------------------------------------------------------------
test('chord coverage: several enabled views have no keyboard jump', async ({ page }) => {
  await gotoApp(page, '#/home')
  // The map in Shell.tsx is { h, p, r, d, m } only — graph/skills/routing/
  // terminal have no chord, and there is no in-app legend listing chords.
  const uncovered = ['Fleet Graph (graph)', 'Skills', 'Routing', 'Terminal']
  add({
    title: 'Keyboard chords cover only 5 of 9 enabled views; no in-app legend',
    severity: 'Low',
    category: 'Missing',
    surface: 'Shell keyboard chords',
    repro: 'Try to jump to graph/skills/routing/terminal with a g-chord.',
    expected: 'Chord parity across enabled views, or a discoverable shortcut legend (the cheatsheet only documents h/p/r/d/m).',
    actual: `No chord for: ${uncovered.join(', ')}. The chord map is { h, p, r, d, m }. There is also no UI surfacing available chords.`,
    evidence: 'Shell.tsx chord map; nothing renders the shortcut list.',
  })
  // Sanity: confirm a non-mapped key after "g" does nothing destructive.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  const before = page.url()
  await page.keyboard.press('g')
  await page.keyboard.press('x') // unmapped
  await page.waitForTimeout(300)
  const after = page.url()
  if (before !== after) {
    add({
      title: 'Unmapped g-chord key changed the route',
      severity: 'Med',
      category: 'Bug',
      surface: 'Shell keyboard chords',
      repro: 'Press "g" then an unmapped key (e.g. "x").',
      expected: 'Unmapped chords are no-ops.',
      actual: `URL changed from ${before} to ${after}.`,
      evidence: 'url before/after',
    })
  }
})

// ---------------------------------------------------------------------------
// 6. Chord must NOT fire while typing in an input (e.g. the ⌘K palette field).
// ---------------------------------------------------------------------------
test('g-chord does not hijack typing inside inputs', async ({ page }) => {
  await gotoApp(page, '#/metrics')
  await waitForWs(page)
  await openBar(page)
  const input = page.getByPlaceholder(/Ask K/i)
  const routeBefore = page.url()
  try {
    // Type a string containing "g" then "h"/"p" — must land as text, not nav.
    await input.click()
    await input.type('graph please')
    const val = await input.inputValue()
    const routeAfter = page.url()
    if (val !== 'graph please') {
      add({
        title: 'Typing in the ⌘K input is corrupted by the chord handler',
        severity: 'High',
        category: 'Bug',
        surface: 'CommandBar input / Shell chord handler',
        repro: 'Open ⌘K and type "graph please".',
        expected: 'The full literal text appears in the input.',
        actual: `Input value was "${val}".`,
        evidence: 'inputValue()',
      })
    }
    if (routeBefore.split('#')[1] !== routeAfter.split('#')[1]) {
      add({
        title: 'A g-chord fired while typing in the ⌘K input (route changed)',
        severity: 'High',
        category: 'Bug',
        surface: 'Shell chord handler',
        repro: 'Open ⌘K, type a phrase containing "g" then a mapped letter.',
        expected: 'Chord handler is suppressed for input/textarea targets (it is, per Shell.tsx).',
        actual: `Route changed from ${routeBefore} to ${routeAfter} while typing.`,
        evidence: 'url before/after typing',
      })
    }
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
  await shot(page, 'P08-chord-in-input')
})

// ---------------------------------------------------------------------------
// 7. ⌘K dual mode: NAVIGATES on a nav-target query, DISPATCHES on a prompt.
//    Flag the ambiguity boundary. We DO NOT actually fire a dispatch (charter:
//    no agent runs) — we only assert which row is highlighted / would run.
// ---------------------------------------------------------------------------
test('⌘K both navigates (nav target) and offers dispatch (prompt) — ambiguity check', async ({ page }) => {
  await gotoApp(page, '#/home')

  // (a) NAVIGATE: typing a nav label jumps. "metrics" matches the Metrics nav.
  await openBar(page)
  let input = page.getByPlaceholder(/Ask K/i)
  await input.fill('metrics')
  // navs rank first when the query substring-matches a label → Enter navigates.
  const navRow = page.getByRole('button', { name: /^\s*∿?\s*Metrics\s*$/i }).first()
  let navigated = false
  try {
    await expect(page.getByRole('button', { name: /Metrics/i }).first()).toBeVisible({ timeout: 4000 })
    await shot(page, 'P08-cmdk-nav')
    await page.keyboard.press('Enter')
    await page.waitForURL(/#\/metrics\b/, { timeout: 6000 })
    navigated = true
  } catch (e) {
    add({
      title: '⌘K did not navigate when typing a nav target ("metrics")',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K navigate mode',
      repro: 'Open ⌘K, type "metrics", press Enter.',
      expected: 'Top row is the Metrics nav and Enter jumps to #/metrics.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P08-cmdk-nav.png',
    })
  }
  void navRow

  // (b) DISPATCH: a prompt that is NOT a nav label shows a "Dispatch agent" row
  //     as the top/Enter action. We assert the row exists; we DO NOT press Enter.
  await openBar(page)
  input = page.getByPlaceholder(/Ask K/i)
  const prompt = 'refactor the auth module and add tests'
  await input.fill(prompt)
  try {
    const dispatchRow = page.getByRole('button', { name: /Dispatch agent:/i }).first()
    await expect(dispatchRow).toBeVisible({ timeout: 4000 })
    await shot(page, 'P08-cmdk-dispatch')
  } catch (e) {
    add({
      title: '⌘K did not offer a dispatch row for a free-text prompt',
      severity: 'High',
      category: 'Bug',
      surface: '⌘K dispatch mode',
      repro: `Open ⌘K, type "${prompt}".`,
      expected: 'A "Dispatch agent: <prompt>" row appears as the runnable action.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P08-cmdk-dispatch.png',
    })
  }

  // (c) AMBIGUITY: a query that BOTH substring-matches a nav label AND is a
  //     plausible prompt. "docs" → navs rank first (Enter navigates), but the
  //     dispatch row for the literal word "docs" is also present lower down.
  //     A user intending to dispatch a prompt that starts with a nav word can
  //     silently navigate instead. Record the ambiguity.
  await openBar(page)
  input = page.getByPlaceholder(/Ask K/i)
  await input.fill('docs')
  try {
    const navFirst = page.locator('ul li').first()
    const firstText = (await navFirst.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    const hasDispatchToo = await page
      .getByRole('button', { name: /Dispatch agent:/i })
      .first()
      .isVisible()
      .catch(() => false)
    await shot(page, 'P08-cmdk-ambiguous')
    // When q matches a nav label, the code puts navs FIRST (Enter = navigate),
    // even though a dispatch row also exists. Flag this as an ambiguity.
    if (/docs/i.test(firstText) && hasDispatchToo) {
      add({
        title: '⌘K ambiguity: a prompt beginning with a nav word silently prefers NAVIGATE on Enter',
        severity: 'Med',
        category: 'UX',
        surface: '⌘K navigate-vs-dispatch',
        repro: 'Open ⌘K, type a word that is also a nav label (e.g. "docs"), press Enter.',
        expected: 'Clear disambiguation between "jump to Docs" and "dispatch a prompt that mentions docs".',
        actual: `Top/Enter row is the nav ("${firstText}") while a Dispatch row also exists below. Enter navigates; the dispatch intent requires arrowing down. No mode toggle / hint distinguishes them.`,
        evidence: 'reports/screens/P08-cmdk-ambiguous.png; CommandBar items[] puts navs before dispatch when q matches a label.',
      })
    }
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 8. Hash deep-links resolve when navigated to directly (cold goto).
// ---------------------------------------------------------------------------
test('hash deep-links resolve via direct page.goto', async ({ page }) => {
  const deep: Array<{ hash: string; title: string }> = [
    { hash: '#/metrics', title: 'Metrics' },
    { hash: '#/docs/project-bible', title: 'Docs' },
    { hash: '#/runs', title: 'Runs' },
    { hash: '#/graph', title: 'Fleet Graph' },
    { hash: '#/routing', title: 'Routing' },
    { hash: '#/skills', title: 'Skills' },
  ]
  for (const d of deep) {
    try {
      await gotoApp(page, d.hash)
      const title = await topBarTitle(page)
      if (!new RegExp(d.title, 'i').test(title)) {
        add({
          title: `Deep-link ${d.hash} did not resolve to the right view`,
          severity: 'High',
          category: 'Bug',
          surface: 'Hash routing (deep-link)',
          repro: `page.goto("/${d.hash}") on a cold load.`,
          expected: `TopBar shows "${d.title}".`,
          actual: `TopBar showed "${title}".`,
          evidence: `reports/screens/P08-deep-${d.hash.replace(/[#/]/g, '_')}.png`,
        })
      }
      await shot(page, `P08-deep-${d.hash.replace(/[#/]/g, '_')}`)
    } catch (e) {
      add({
        title: `Deep-link ${d.hash} failed to load`,
        severity: 'High',
        category: 'Bug',
        surface: 'Hash routing (deep-link)',
        repro: `page.goto("/${d.hash}") cold.`,
        expected: 'Resolves to its view with WS connected.',
        actual: String(e).slice(0, 300),
        evidence: 'gotoApp threw',
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 9. UNKNOWN route behavior: #/nonsense. Record blank / fallback / error.
//    From route.ts + Shell.tsx: parse() returns view='nonsense', no view branch
//    matches → <main> renders EMPTY; TopBar's dest lookup misses → falls back to
//    the Home icon+title. So the chrome lies (says "Home") over a blank canvas.
// ---------------------------------------------------------------------------
test('unknown route (#/nonsense) is handled (no crash; record fallback)', async ({ page }) => {
  // Don't gate on WS via gotoApp's title selector — just navigate raw + wait WS.
  await page.goto('/#/nonsense')
  let wsOk = true
  try {
    await waitForWs(page)
  } catch {
    wsOk = false
  }
  await shot(page, 'P08-unknown-route')

  const title = await topBarTitle(page)
  // The <main> content area: gather its visible text to judge blank vs fallback.
  const mainText = (await page.locator('main').innerText().catch(() => '')).trim()
  const crashed = sink?.pageErrors.length > 0

  if (crashed) {
    add({
      title: 'Unknown route crashes the app (uncaught page error)',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Hash routing / Shell',
      repro: 'page.goto("/#/nonsense").',
      expected: 'Unknown routes show a 404/empty-state, not a crash.',
      actual: sink.pageErrors.join('\n').slice(0, 400),
      evidence: 'reports/screens/P08-unknown-route.png; page.on("pageerror")',
    })
  }

  // Behavior record: blank main + misleading "Home" chrome is the real issue.
  add({
    title: 'Unknown route renders a BLANK content area while chrome falls back to "Home"',
    severity: mainText.length < 5 ? 'Med' : 'Low',
    category: 'UX',
    surface: 'Hash routing / Shell + TopBar',
    repro: 'Navigate directly to #/nonsense (or any unrouted hash).',
    expected: 'A 404 / "no such view" empty-state, or a redirect to Home — not a blank canvas under a "Home" title.',
    actual: `WS connected=${wsOk}. TopBar title="${title}" (falls back to Home because no DESTINATION matches view "nonsense"). <main> text length=${mainText.length} ("${mainText.slice(0, 80)}"). No view branch in Shell matches, so the stage is empty. No 404 affordance, no redirect.`,
    evidence: 'reports/screens/P08-unknown-route.png; Shell.tsx has no default/404 branch; TopBar uses ?? Home fallback.',
  })
})

// ---------------------------------------------------------------------------
// 10. Browser back/forward across several navigations.
// ---------------------------------------------------------------------------
test('browser back/forward history works across navigations', async ({ page }) => {
  await gotoApp(page, '#/home')
  // Build a small history stack via the sidebar.
  const sequence = ['Projects', 'Metrics', 'Runs', 'Docs']
  for (const label of sequence) {
    await page.getByRole('button', { name: label, exact: true }).click()
    // give the hashchange listener a beat
    await page.waitForTimeout(150)
  }
  // After the sequence we should be on docs.
  await page.waitForURL(/#\/docs\b/, { timeout: 5000 }).catch(() => {})

  try {
    // Back twice → should land on Metrics (docs ← runs ← metrics).
    await page.goBack()
    await page.waitForURL(/#\/runs\b/, { timeout: 5000 })
    await page.goBack()
    await page.waitForURL(/#\/metrics\b/, { timeout: 5000 })
    const titleAfterBack = await topBarTitle(page)
    // Forward once → back to Runs.
    await page.goForward()
    await page.waitForURL(/#\/runs\b/, { timeout: 5000 })
    const titleAfterFwd = await topBarTitle(page)
    await shot(page, 'P08-history')
    if (!/metrics/i.test(titleAfterBack) || !/runs/i.test(titleAfterFwd)) {
      add({
        title: 'Back/forward did not restore the expected view title',
        severity: 'Med',
        category: 'Bug',
        surface: 'Hash routing / history',
        repro: 'Navigate Projects→Metrics→Runs→Docs, then Back, Back, Forward.',
        expected: 'Back lands on Metrics; Forward returns to Runs.',
        actual: `After 2x Back title="${titleAfterBack}"; after Forward title="${titleAfterFwd}".`,
        evidence: 'reports/screens/P08-history.png',
      })
    }
  } catch (e) {
    add({
      title: 'Browser back/forward navigation failed',
      severity: 'High',
      category: 'Bug',
      surface: 'Hash routing / history',
      repro: 'Build a nav stack then use the browser Back/Forward buttons.',
      expected: 'History traverses the hash routes correctly.',
      actual: String(e).slice(0, 400),
      evidence: 'goBack/goForward threw or URL mismatch',
    })
  }
})

// ---------------------------------------------------------------------------
// 11. Full-page reload on a deep route — state/route should persist.
// ---------------------------------------------------------------------------
test('full reload on a deep route persists the route', async ({ page }) => {
  await gotoApp(page, '#/docs/project-bible')
  await waitForWs(page)
  const before = page.url()
  await page.reload()
  let wsOk = true
  try {
    await waitForWs(page)
  } catch {
    wsOk = false
  }
  const after = page.url()
  const title = await topBarTitle(page)
  await shot(page, 'P08-reload-deep')
  if (before.split('#')[1] !== after.split('#')[1]) {
    add({
      title: 'Full reload on a deep route does NOT persist the route',
      severity: 'High',
      category: 'Bug',
      surface: 'Hash routing / reload',
      repro: 'Open #/docs/project-bible, hard-reload the page.',
      expected: 'The same hash route is restored after reload.',
      actual: `Before=${before}, after=${after} (title "${title}").`,
      evidence: 'reports/screens/P08-reload-deep.png',
    })
  }
  if (!wsOk) {
    add({
      title: 'WS did not reconnect after a full reload within 30s',
      severity: 'Med',
      category: 'Bug',
      surface: 'WS status dot / reconnect',
      repro: 'Hard-reload a deep route and watch the status dot.',
      expected: 'The status dot returns to green (core connected) promptly.',
      actual: 'Status dot never went green within 30s after reload.',
      evidence: 'reports/screens/P08-reload-deep.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 12. WS reconnect indicator behavior — observe the dot. The Shell flips to
//     "connected" optimistically after 1.5s OR on the first WS message, and
//     follows onWsStatus thereafter. Record the dot's initial→connected path.
// ---------------------------------------------------------------------------
test('WS status dot reflects connection state', async ({ page }) => {
  // Fresh load: capture whether we ever see the amber "connecting…" dot first.
  await page.goto('/#/home')
  let sawConnecting = false
  try {
    sawConnecting = await page
      .locator('[title="connecting…"]')
      .first()
      .isVisible()
      .catch(() => false)
  } catch {
    /* timing-dependent */
  }
  // It must end green.
  let green = true
  try {
    await waitForWs(page)
  } catch {
    green = false
  }
  await shot(page, 'P08-ws-dot')
  if (!green) {
    add({
      title: 'WS status dot never reached green (core connected)',
      severity: 'High',
      category: 'Bug',
      surface: 'TopBar WS dot',
      repro: 'Load #/home and wait for the status dot.',
      expected: 'Dot turns green within 30s.',
      actual: 'Dot stayed amber/connecting.',
      evidence: 'reports/screens/P08-ws-dot.png',
    })
  } else {
    add({
      title: 'WS status dot resolves to connected (informational)',
      severity: 'Nit',
      category: 'UX',
      surface: 'TopBar WS dot',
      repro: 'Load #/home and observe the dot.',
      expected: 'Amber connecting → green connected.',
      actual: `Reached green=${green}. Observed amber "connecting…" first=${sawConnecting} (Shell flips optimistic after 1.5s, so amber is often too brief to catch). Note: the dot conveys state only via color + title tooltip — no text label for at-a-glance reading.`,
      evidence: 'reports/screens/P08-ws-dot.png',
    })
  }
})

// ---------------------------------------------------------------------------
// Fail-loud: console/page errors during this persona's flow are findings.
// (Run last so per-test afterEach captures are attributed once.)
// ---------------------------------------------------------------------------
test.afterEach(async ({ page }, testInfo) => {
  if (sink?.pageErrors.length) {
    add({
      title: `Uncaught page error during "${testInfo.title}"`,
      severity: 'Critical',
      category: 'Bug',
      surface: 'Navigation / keyboard',
      repro: `During: ${testInfo.title}.`,
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
    sink.pageErrors = []
  }
  if (sink?.errors.length) {
    const meaningful = sink.errors.filter((e) => !/Failed to load resource/i.test(e))
    if (meaningful.length) {
      add({
        title: `console.error during "${testInfo.title}"`,
        severity: 'High',
        category: 'Bug',
        surface: 'Navigation / keyboard',
        repro: `During: ${testInfo.title}.`,
        expected: 'No unexpected console.error in a clean session.',
        actual: meaningful.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
    sink.errors = []
  }
})

test.afterAll(() => {
  try {
    writeFindings('P08', CHARTER, findings)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('writeFindings failed:', e)
  }
})

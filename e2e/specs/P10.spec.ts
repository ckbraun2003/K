import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
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

// The harness bible's section markdown lives on disk (NOT as DB artifacts) and the
// recompile endpoint reads it from there. e2e/specs → repo root is two levels up.
const BIBLE_SECTIONS_DIR = path.resolve(__dirname, '..', '..', 'artifacts', 'bible', 'sections')

// ===========================================================================
// P10 — Docs / Help / Artifacts
// Charter (adversarial; the docs experience a real operator relies on):
//  - Open Docs (#/docs) + default project-bible: assert it renders (not blank),
//    the artifact list/sidebar works, and navigation between artifacts works.
//  - Help (❔) deep-links to docs/project-bible — confirm it lands and §10 "How
//    to Use K" content is present and readable.
//  - Unknown docs slug (#/docs/does-not-exist) — record behavior (404/blank/fallback).
//  - Bible edit & recompile: edit a section's markdown, recompile, assert the
//    rendered bible HTML reflects it. NEVER hand-edit compiled HTML. Confirm the
//    recompile gives feedback and isn't silently slow.
//  - UI artifacts: open the ui-demo artifact and assert it renders sandboxed and
//    doesn't break the app or spew console errors.
//  - Judge docs against §10's promises (Getting Started, Help, tooltips) — flag
//    claim-vs-reality gaps as Docs-mismatch.
//  - Time bible compile/recompile + large-doc render; flag long waits w/o feedback.
//
// Resilient: every exploratory interaction is wrapped so one broken surface
// can't abort the run before writeFindings. Bible recompile is allowed (cheap);
// no agent dispatch; no app-source edits.
// ===========================================================================

const CHARTER =
  'Docs/Help/Artifacts: render the bible in #/docs, artifact sidebar + cross-artifact nav, Help deep-link to §10, unknown-slug behavior, bible edit→recompile reflected in the rendered Docs view, sandboxed UI artifact (ui-demo), and §10 claim-vs-reality gaps.'
const findings: Finding[] = []
let sink: ConsoleSink

// The Docs DocViewer iframe is sandboxed WITHOUT allow-same-origin (allow-scripts
// only). The compiled bible's inline <script> uses navigator.clipboard, which a
// null-origin sandboxed frame blocks → an expected console.error. Record once.
let bibleClipboardNoticed = false
let resource404Noticed = false
const CLIPBOARD_RE = /clipboard|NotAllowedError|allow-same-origin|secure context/i
// The unknown-slug test and the §10 section probe deliberately hit 404s; the app
// handles them inline (not-found state), but the raw fetch still logs to console.
const RESOURCE_4XX_RE = /Failed to load resource: the server responded with a status of 4\d\d/i

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// --- helpers ---------------------------------------------------------------

/**
 * gotoApp hard-asserts the WS dot, which on a slow/degraded stack can throw
 * before a test's own try/catch and abort the serial run. Retry once; on
 * persistent failure record a Perf finding and continue — never let a transient
 * reconnect block reaching writeFindings.
 */
async function gotoAppResilient(page: Page, hash: string, where: string): Promise<void> {
  try {
    await gotoApp(page, hash)
  } catch {
    await page.reload().catch(() => {})
    try {
      await waitForWs(page)
    } catch (e) {
      findings.push({
        title: `WS did not connect promptly when navigating to ${hash}`,
        severity: 'Med',
        category: 'Perf',
        surface: where,
        repro: `Navigate to ${hash} and wait for the "core connected" status dot.`,
        expected: 'WS reconnects within ~30s even after a recompile.',
        actual: `WS dot not visible after a retry: ${String(e).slice(0, 200)}`,
        evidence: 'harness.waitForWs timeout',
      })
    }
  }
}

/** The Docs view embeds each artifact's HTML in a sandboxed iframe (no title set
 *  on bible vs ui-demo — both use the artifact title). Returns the first iframe. */
function docFrame(page: Page) {
  return page.locator('section iframe').first()
}

// ---------------------------------------------------------------------------

test('Docs (#/docs) renders the project-bible by default — not blank', async ({ page }) => {
  // Warm up first (Vite dep-optimize one-time cost), then time the warm nav.
  await gotoAppResilient(page, '#/docs', 'Docs')
  const { ms } = await timed(() => gotoAppResilient(page, '#/docs', 'Docs'))
  await screenshot(page, 'P10-docs-default')

  try {
    // Sidebar "Artifacts" header + at least one artifact button.
    await expect(page.getByRole('heading', { name: /Artifacts/i })).toBeVisible({ timeout: 10_000 })

    // DocViewer header should show the bible title (the default active slug is
    // 'project-bible'). The header <h2> carries the artifact title.
    const viewerHeader = page.locator('section h2').first()
    const headerText = (await viewerHeader.innerText().catch(() => '')).trim()
    if (!headerText) {
      findings.push({
        title: 'Docs viewer header is blank on the default project-bible',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / DocViewer',
        repro: 'Open #/docs (no slug) and read the viewer header.',
        expected: 'The compiled bible loads with a title (e.g. the manifest title).',
        actual: 'No viewer header text rendered.',
        evidence: 'reports/screens/P10-docs-default.png',
      })
    }

    // The bible renders inside a sandboxed iframe; assert its body has real content.
    const frame = docFrame(page)
    const hasFrame = await frame.isVisible({ timeout: 8_000 }).catch(() => false)
    if (!hasFrame) {
      // Could be the .md fallback view, or "Artifact not found". Detect blankness.
      const bodyText = (await page.locator('section').first().innerText().catch(() => '')).trim()
      findings.push({
        title: 'Default Docs bible did not render in an iframe',
        severity: bodyText.length === 0 ? 'High' : 'Med',
        category: 'Bug',
        surface: 'Docs / DocViewer',
        repro: 'Open #/docs and look for the compiled-HTML iframe.',
        expected: 'DocViewer defaults to the .html view; the compiled bible shows in a sandboxed iframe.',
        actual: `No iframe visible. Section text length=${bodyText.length}.`,
        evidence: 'reports/screens/P10-docs-default.png',
      })
    } else {
      const frameText = (await page.frameLocator('section iframe').first().locator('body').innerText().catch(() => '')).trim()
      if (frameText.length < 40) {
        findings.push({
          title: 'Compiled bible iframe renders (near-)empty in Docs',
          severity: 'High',
          category: 'Bug',
          surface: 'Docs / DocViewer',
          repro: 'Open #/docs; inspect the iframe body text.',
          expected: 'The bible HTML body has substantial readable content.',
          actual: `iframe body innerText length=${frameText.length}.`,
          evidence: 'reports/screens/P10-docs-default.png',
        })
      }
    }
  } catch (e) {
    findings.push({
      title: 'Docs default view crashed while rendering the bible',
      severity: 'High',
      category: 'Bug',
      surface: 'Docs / DocViewer',
      repro: 'Open #/docs.',
      expected: 'The bible renders without throwing.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-docs-default.png',
    })
  }

  if (ms > 5000) {
    findings.push({
      title: 'Docs view is slow to become interactive',
      severity: 'Med',
      category: 'Perf',
      surface: 'Docs',
      repro: 'Navigate to #/docs (warm) and wait for WS + bible render.',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${ms}ms.`,
      evidence: 'reports/screens/P10-docs-default.png; harness.timed().',
    })
  }
})

test('artifact sidebar lists items and the ui-demo artifact is present', async ({ page }) => {
  await gotoAppResilient(page, '#/docs', 'Docs')
  try {
    // The sidebar renders one <button> per artifact (slug + title + date).
    const sidebarBtns = page.locator('aside button')
    const count = await sidebarBtns.count()
    await screenshot(page, 'P10-docs-sidebar')

    if (count === 0) {
      findings.push({
        title: 'Docs artifact sidebar is empty',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / sidebar',
        repro: 'Open #/docs; count buttons in the Artifacts sidebar.',
        expected: 'At least the project-bible and the ui-demo artifact are listed (seeded at startup).',
        actual: 'No artifact buttons rendered.',
        evidence: 'reports/screens/P10-docs-sidebar.png',
      })
    }

    // The ui-demo Command Deck artifact is seeded at startup (seedUiDemo).
    const uiDemo = page.getByRole('button', { name: /Command Deck.*UI Demo/i }).first()
    const uiDemoVisible = await uiDemo.isVisible().catch(() => false)
    if (!uiDemoVisible) {
      findings.push({
        title: 'Seeded ui-demo artifact missing from the Docs sidebar',
        severity: 'Med',
        category: 'Missing',
        surface: 'Docs / sidebar',
        repro: 'Open #/docs; look for "Command Deck — UI Demo" in the sidebar.',
        expected: 'seedUiDemo runs at startup, so the Command Deck demo should be listed.',
        actual: 'No "Command Deck — UI Demo" entry found in the sidebar.',
        evidence: 'reports/screens/P10-docs-sidebar.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Docs sidebar enumeration crashed',
      severity: 'Med',
      category: 'Bug',
      surface: 'Docs / sidebar',
      repro: 'Open #/docs; enumerate sidebar artifact buttons.',
      expected: 'Sidebar lists artifacts.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-docs-sidebar.png',
    })
  }
})

test('navigating between artifacts updates the viewer (bible ↔ ui-demo)', async ({ page }) => {
  await gotoAppResilient(page, '#/docs', 'Docs')
  try {
    const before = (await page.locator('section h2').first().innerText().catch(() => '')).trim()

    // Click the ui-demo entry; the URL hash + viewer header should change.
    const uiDemo = page.getByRole('button', { name: /Command Deck.*UI Demo/i }).first()
    if (await uiDemo.isVisible().catch(() => false)) {
      await uiDemo.click()
      await page.waitForURL(/#\/docs\/ui-demo/, { timeout: 8_000 }).catch(() => {})
      await page.waitForTimeout(600)
      await screenshot(page, 'P10-docs-uidemo')
      const after = (await page.locator('section h2').first().innerText().catch(() => '')).trim()
      if (after === before || !/UI Demo/i.test(after)) {
        findings.push({
          title: 'Selecting a different artifact did not update the Docs viewer',
          severity: 'High',
          category: 'Bug',
          surface: 'Docs / navigation',
          repro: 'Open #/docs (bible), click the "Command Deck — UI Demo" sidebar entry.',
          expected: 'URL → #/docs/ui-demo and the viewer header switches to the UI demo title.',
          actual: `Header before="${before}", after="${after}".`,
          evidence: 'reports/screens/P10-docs-uidemo.png',
        })
      }
    } else {
      findings.push({
        title: 'Could not test cross-artifact navigation — ui-demo entry absent',
        severity: 'Low',
        category: 'Missing',
        surface: 'Docs / navigation',
        repro: 'Open #/docs; click a second artifact.',
        expected: 'A second artifact exists to navigate to.',
        actual: 'Only the bible (or no second artifact) was present.',
        evidence: 'reports/screens/P10-docs-sidebar.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Cross-artifact navigation crashed',
      severity: 'Med',
      category: 'Bug',
      surface: 'Docs / navigation',
      repro: 'Open #/docs; click a different artifact.',
      expected: 'Viewer switches artifacts without throwing.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-docs-uidemo.png',
    })
  }
})

test('the ui-demo artifact renders in a sandboxed iframe (allow-scripts)', async ({ page }) => {
  await gotoAppResilient(page, '#/docs/ui-demo', 'Docs / ui-demo')
  try {
    const frame = docFrame(page)
    const visible = await frame.isVisible({ timeout: 8_000 }).catch(() => false)
    await screenshot(page, 'P10-uidemo-iframe')

    if (!visible) {
      findings.push({
        title: 'UI-demo artifact did not render in an iframe',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / DocViewer (ui-demo)',
        repro: 'Open #/docs/ui-demo.',
        expected: 'The interactive Command Deck demo shows in a sandboxed iframe.',
        actual: 'No iframe was visible.',
        evidence: 'reports/screens/P10-uidemo-iframe.png',
      })
      return
    }

    // Assert the sandbox attribute: ui-demo should be allow-scripts (interactive),
    // critically WITHOUT allow-same-origin (untrusted-content isolation).
    const sandbox = (await frame.getAttribute('sandbox')) ?? ''
    if (!/allow-scripts/.test(sandbox)) {
      findings.push({
        title: 'UI-demo iframe is not allow-scripts — the interactive demo cannot run',
        severity: 'Med',
        category: 'Bug',
        surface: 'Docs / DocViewer (ui-demo)',
        repro: 'Open #/docs/ui-demo; read the iframe sandbox attribute.',
        expected: 'sandbox includes allow-scripts so the demo JS (clock, dispatch) runs.',
        actual: `sandbox="${sandbox}".`,
        evidence: 'reports/screens/P10-uidemo-iframe.png',
      })
    }
    if (/allow-same-origin/.test(sandbox)) {
      findings.push({
        title: 'UI-demo iframe combines allow-scripts AND allow-same-origin (sandbox escape)',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / DocViewer (ui-demo)',
        repro: 'Open #/docs/ui-demo; read the iframe sandbox attribute.',
        expected:
          'A scriptable artifact frame must NOT also be allow-same-origin (that pair lets the frame remove its own sandbox).',
        actual: `sandbox="${sandbox}".`,
        evidence: 'reports/screens/P10-uidemo-iframe.png',
      })
    }

    // The demo runs JS — its clock should be live (not the "--:--:--" placeholder).
    const fl = page.frameLocator('section iframe').first()
    const clock = await fl.locator('#clock').innerText({ timeout: 5_000 }).catch(() => '')
    if (clock && /^--:--:--$/.test(clock.trim())) {
      findings.push({
        title: 'UI-demo script did not run (clock stuck at placeholder)',
        severity: 'Low',
        category: 'UX',
        surface: 'Docs / DocViewer (ui-demo)',
        repro: 'Open #/docs/ui-demo; read the #clock element in the iframe.',
        expected: 'The inline script ticks the clock once mounted.',
        actual: `Clock text: "${clock}".`,
        evidence: 'reports/screens/P10-uidemo-iframe.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'UI-demo render check crashed',
      severity: 'Med',
      category: 'Bug',
      surface: 'Docs / DocViewer (ui-demo)',
      repro: 'Open #/docs/ui-demo.',
      expected: 'Sandboxed iframe renders the interactive demo.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-uidemo-iframe.png',
    })
  }
})

test('Help (❔) deep-links to the bible and §10 "How to Use K" content is present', async ({ page }) => {
  await gotoAppResilient(page, '#/home', 'Home')
  try {
    const { ms } = await timed(async () => {
      await page.getByRole('button', { name: 'Help' }).click()
      await page.waitForURL(/#\/docs/, { timeout: 15_000 })
    })
    await waitForWs(page)
    await page.waitForTimeout(800)
    await screenshot(page, 'P10-help-docs')

    // It should land on the bible (project-bible), not some other artifact.
    if (!/#\/docs\/project-bible/.test(page.url())) {
      findings.push({
        title: 'Help does not deep-link to docs/project-bible specifically',
        severity: 'Low',
        category: 'UX',
        surface: 'Sidebar Help',
        repro: 'Home → click Help (❔); read the URL.',
        expected: 'Help targets #/docs/project-bible (the user guide lives in the bible).',
        actual: `Landed on ${page.url()}.`,
        evidence: 'reports/screens/P10-help-docs.png',
      })
    }

    // §10 "User Guide" content must be readable inside the bible iframe. Probe for
    // its distinctive headings/phrases.
    const fl = page.frameLocator('section iframe').first()
    const guideMarkers = [
      /User Guide/i,
      /Getting started/i,
      /Registering a project/i,
      /Dispatching an agent run/i,
    ]
    let foundCount = 0
    for (const re of guideMarkers) {
      const ok = await fl.getByText(re).first().isVisible({ timeout: 4_000 }).catch(() => false)
      if (ok) foundCount++
    }
    if (foundCount === 0) {
      findings.push({
        title: 'Help lands in Docs but §10 user-guide content is not visible',
        severity: 'High',
        category: 'Docs-mismatch',
        surface: 'Docs / bible §10',
        repro: 'Home → Help → inspect the bible iframe for §10 guide headings.',
        expected:
          'Bible §10 promises an in-app user guide reachable from Help; its headings (Getting started, Registering a project, …) should be present.',
        actual: 'None of the §10 guide markers were visible in the rendered bible.',
        evidence: 'reports/screens/P10-help-docs.png',
      })
    } else if (foundCount < guideMarkers.length) {
      findings.push({
        title: 'Only part of the §10 user guide is visible after Help',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: 'Docs / bible §10',
        repro: 'Home → Help → probe for §10 guide section headings.',
        expected: 'All key §10 sections render.',
        actual: `Found ${foundCount}/${guideMarkers.length} expected §10 markers.`,
        evidence: 'reports/screens/P10-help-docs.png',
      })
    }

    if (ms > 2000) {
      findings.push({
        title: 'Help → Docs navigation has no loading feedback',
        severity: 'Low',
        category: 'Perf',
        surface: 'Sidebar Help / Docs',
        repro: 'Home → click Help (❔); time until Docs lands.',
        expected: 'Sub-second nav, or a spinner if the bible is large.',
        actual: `Took ${ms}ms.`,
        evidence: 'reports/screens/P10-help-docs.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Help deep-link flow crashed',
      severity: 'High',
      category: 'Bug',
      surface: 'Sidebar Help',
      repro: 'Home → click Help.',
      expected: 'Navigates to the bible with the §10 guide readable.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-help-docs.png',
    })
  }
})

test('unknown docs slug (#/docs/does-not-exist) degrades gracefully', async ({ page }) => {
  await gotoAppResilient(page, '#/docs/does-not-exist', 'Docs / unknown slug')
  try {
    await page.waitForTimeout(1000)
    await screenshot(page, 'P10-unknown-slug')

    // Expectation: DocViewer's query 404s → no artifact → "Artifact not found".
    // The sidebar should still render so the user can recover.
    const notFound = await page.getByText(/Artifact not found/i).first().isVisible({ timeout: 6_000 }).catch(() => false)
    const sidebarStillThere = await page.getByRole('heading', { name: /Artifacts/i }).isVisible().catch(() => false)
    const loadingStuck = await page.getByText(/^Loading…$/).first().isVisible().catch(() => false)

    if (!sidebarStillThere) {
      findings.push({
        title: 'Unknown docs slug breaks the whole Docs page (sidebar gone)',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / unknown slug',
        repro: 'Navigate to #/docs/does-not-exist.',
        expected: 'Sidebar remains so the user can pick a valid artifact; viewer shows a not-found state.',
        actual: 'The Artifacts sidebar was not visible.',
        evidence: 'reports/screens/P10-unknown-slug.png',
      })
    }
    if (loadingStuck) {
      findings.push({
        title: 'Unknown docs slug leaves the viewer stuck on "Loading…"',
        severity: 'Med',
        category: 'Bug',
        surface: 'Docs / unknown slug',
        repro: 'Navigate to #/docs/does-not-exist.',
        expected: 'A definitive not-found state, not an indefinite spinner.',
        actual: 'Viewer remained on the "Loading…" placeholder after the 404.',
        evidence: 'reports/screens/P10-unknown-slug.png',
      })
    }
    if (!notFound && !loadingStuck) {
      // Neither the documented fallback nor a stuck spinner — record what we saw.
      const viewerText = (await page.locator('section').first().innerText().catch(() => '')).trim()
      findings.push({
        title: 'Unknown docs slug shows no clear not-found message',
        severity: 'Med',
        category: 'UX',
        surface: 'Docs / unknown slug',
        repro: 'Navigate to #/docs/does-not-exist.',
        expected: 'A clear "not found" message (DocViewer has an "Artifact not found" state).',
        actual: `Neither "Artifact not found" nor a spinner was shown. Viewer text: "${viewerText.slice(0, 160)}".`,
        evidence: 'reports/screens/P10-unknown-slug.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Unknown-slug handling crashed the Docs page',
      severity: 'High',
      category: 'Bug',
      surface: 'Docs / unknown slug',
      repro: 'Navigate to #/docs/does-not-exist.',
      expected: 'Graceful not-found, app intact.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-unknown-slug.png',
    })
  }
})

test('bible edit → recompile is reflected in the rendered Docs view', async ({ page }) => {
  // The #/docs DocViewer is READ-ONLY (no in-app editor) — the section editor +
  // Recompile live in the project-workspace Bible tab. The recompile endpoint
  // recompiles the HARNESS bible (artifacts/bible/) which is exactly what
  // #/docs/project-bible renders. The harness bible's sections are FILES on disk
  // (artifacts/bible/sections/NN-slug.md), NOT DB artifacts — the recompiler
  // reads them from disk. So the faithful "does an edit reach the Docs
  // experience" test is: edit the §10 section file → POST /api/bible/compile →
  // verify the change renders in #/docs/project-bible. We restore the file
  // verbatim afterward. NEVER touch the compiled HTML directly. (Editing section
  // markdown + recompiling is the documented, sanctioned flow; recompile is cheap.)
  const SECTION_FILE = path.join(BIBLE_SECTIONS_DIR, '10-user-guide.md')
  const marker = `P10EDIT-${Date.now()}`
  let originalMd: string | null = null
  let restored = false

  try {
    if (!fs.existsSync(SECTION_FILE)) {
      findings.push({
        title: 'Bible §10 section file not found on disk for the edit→recompile test',
        severity: 'Med',
        category: 'Bug',
        surface: 'Docs / bible sections',
        repro: `Look for ${SECTION_FILE}.`,
        expected: 'The §10 user-guide section exists under artifacts/bible/sections/.',
        actual: 'File missing.',
        evidence: 'fs.existsSync',
      })
    } else {
      // 1) Read + 2) append a unique visible marker (a plain md line, so it must
      //    survive into the rendered HTML — an HTML comment could be stripped).
      originalMd = fs.readFileSync(SECTION_FILE, 'utf8')
      fs.writeFileSync(SECTION_FILE, `${originalMd}\n\nMARKER ${marker} appended by P10.\n`, 'utf8')

      // 3) Recompile, timing it; confirm the endpoint reports sections compiled.
      const { ms, value: compileRes } = await timed(() => page.request.post('/api/bible/compile'))
      const compileOk = compileRes.ok()
      const compileBody = compileOk
        ? ((await compileRes.json()) as { sections?: string[]; compiledAt?: number })
        : null
      if (!compileOk) {
        findings.push({
          title: 'Bible recompile endpoint failed',
          severity: 'High',
          category: 'Bug',
          surface: 'Docs / bible recompile',
          repro: 'POST /api/bible/compile after editing a section.',
          expected: 'Recompile returns 200 with the compiled section list.',
          actual: `HTTP ${compileRes.status()}.`,
          evidence: 'page.request capture',
        })
      } else if (!compileBody?.sections?.includes('10-user-guide')) {
        findings.push({
          title: 'Recompile response omits the edited §10 section',
          severity: 'Med',
          category: 'Bug',
          surface: 'Docs / bible recompile',
          repro: 'POST /api/bible/compile; inspect the returned sections list.',
          expected: 'The compiled-section list includes 10-user-guide.',
          actual: `sections=${JSON.stringify(compileBody?.sections)}.`,
          evidence: 'page.request capture',
        })
      }
      if (ms > 5000) {
        findings.push({
          title: 'Bible recompile is slow',
          severity: 'Med',
          category: 'Perf',
          surface: 'Docs / bible recompile',
          repro: 'POST /api/bible/compile; time the response.',
          expected: 'Recompile of a modest bible completes in a couple seconds.',
          actual: `Took ${ms}ms (${compileBody?.sections?.length ?? '?'} sections).`,
          evidence: 'harness.timed()',
        })
      }

      // 4) Open #/docs/project-bible and assert the marker is in the rendered HTML.
      //    Force a fresh artifact fetch (the DocViewer caches with staleTime:30s).
      await gotoAppResilient(page, '#/docs/project-bible', 'Docs / bible')
      await page.waitForTimeout(900)
      await screenshot(page, 'P10-bible-recompiled')

      const fl = page.frameLocator('section iframe').first()
      const renderedVisible = await fl
        .getByText(new RegExp(marker))
        .first()
        .isVisible({ timeout: 6_000 })
        .catch(() => false)
      // Belt & suspenders: check the iframe srcdoc HTML directly.
      const srcdoc = (await docFrame(page).getAttribute('srcdoc').catch(() => '')) ?? ''
      const inSrc = srcdoc.includes(marker)

      if (!renderedVisible && !inSrc) {
        findings.push({
          title: 'Bible edit did not reflect in the rendered Docs view after recompile',
          severity: 'High',
          category: 'Bug',
          surface: 'Docs / bible recompile',
          repro:
            'Edit artifacts/bible/sections/10-user-guide.md → POST /api/bible/compile → open #/docs/project-bible.',
          expected: 'Bible §10: edit + recompile re-renders with the change; the marker appears.',
          actual:
            'The unique marker was not found in the recompiled bible HTML rendered in #/docs (possible stale-cache or recompile gap).',
          evidence: 'reports/screens/P10-bible-recompiled.png',
        })
      }
    }
  } catch (e) {
    findings.push({
      title: 'Bible edit→recompile flow crashed',
      severity: 'High',
      category: 'Bug',
      surface: 'Docs / bible recompile',
      repro: 'Edit the §10 section file, recompile, view #/docs/project-bible.',
      expected: 'Edit persists and renders after recompile.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P10-bible-recompiled.png',
    })
  } finally {
    // 5) Restore the original section file + recompile so we leave no residue.
    if (originalMd !== null) {
      try {
        fs.writeFileSync(SECTION_FILE, originalMd, 'utf8')
        const r = await page.request.post('/api/bible/compile')
        restored = r.ok() && fs.readFileSync(SECTION_FILE, 'utf8') === originalMd
      } catch {
        restored = false
      }
    }
    if (originalMd !== null && !restored) {
      findings.push({
        title: 'Could not restore the edited bible section after the test',
        severity: 'Low',
        category: 'Bug',
        surface: 'Docs / bible sections',
        repro: 'After the edit→recompile test, restore the original §10 markdown file.',
        expected: 'The test cleans up its own edit (idempotent stack).',
        actual: 'Restore write/recompile did not succeed.',
        evidence: 'fs.writeFileSync + page.request capture',
      })
    }
  }
})

test('Docs-mismatch: harness bible sections are not individually editable as artifacts', async ({ page }) => {
  // §10 "Editing a project's bible": "each section has an edit action that opens
  // the markdown source." The BibleTab editor's "Edit section…" picker is fed by
  // GET /api/artifacts (minus project-bible). But the harness bible's OWN sections
  // (01-vision … 10-user-guide) live as files on disk and are NOT exposed as DB
  // artifacts — GET /api/artifacts/10-user-guide returns 404. So in the Docs/Help
  // surface there is no section to edit, and in the workspace Bible tab the picker
  // lists only ui-demo (and project demos), never the actual bible sections.
  try {
    const res = await page.request.get('/api/artifacts/10-user-guide')
    if (res.status() === 404) {
      findings.push({
        title: 'Bible sections are not editable per §10 in the harness (sections aren\'t artifacts)',
        severity: 'Med',
        category: 'Docs-mismatch',
        surface: 'Docs / bible §10 / artifacts API',
        repro:
          'GET /api/artifacts/10-user-guide (or open the workspace Bible tab "Edit section…" picker).',
        expected:
          '§10 promises a per-section edit action opening the markdown source; sections should be reachable as artifacts.',
        actual:
          'GET /api/artifacts/10-user-guide → 404. Bible sections live as files on disk; only the combined "project-bible" artifact and "ui-demo" are exposed via the artifacts API, so the §10 "edit each section" affordance has no target for the harness bible.',
        evidence: 'page.request capture (HTTP 404)',
      })
    }
  } catch {
    /* non-fatal */
  }
})

test('Docs-mismatch: §10 promises an in-app editor "edit action" per section', async ({ page }) => {
  // §10 "Editing a project's bible": "each section has an edit action that opens
  // the markdown source." That editor lives ONLY in the project-workspace Bible
  // tab — the #/docs experience (where Help sends users and the user guide lives)
  // is strictly read-only with no per-section edit affordance. Record the gap a
  // real operator hits when they follow §10 from Help.
  await gotoAppResilient(page, '#/docs', 'Docs')
  try {
    const editAffordance = await page
      .getByRole('button', { name: /edit|recompile/i })
      .first()
      .isVisible()
      .catch(() => false)
    await screenshot(page, 'P10-docs-no-editor')
    if (!editAffordance) {
      findings.push({
        title: 'No edit/recompile affordance in #/docs, where §10 sends operators',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: 'Docs / bible §10',
        repro:
          '§10 "Editing a project\'s bible" describes a per-section edit action; open #/docs (the Help destination) and look for one.',
        expected:
          'Either an edit affordance in the Docs view, or §10 should clarify that editing lives in the project-workspace Bible tab (not the read-only Docs/Help view).',
        actual:
          'The Docs view is read-only (.md/.html toggle only). The section editor + Recompile exist solely in the project-workspace Bible tab.',
        evidence: 'reports/screens/P10-docs-no-editor.png',
      })
    }
  } catch {
    /* non-fatal */
  }
})

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during the Docs/Help flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Docs / Help',
      repro: 'Drive the Docs/Help flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    // The Docs iframe is sandboxed allow-scripts WITHOUT allow-same-origin; the
    // compiled bible's inline script calls navigator.clipboard, which a null-origin
    // frame blocks → an expected console.error. Record once as a UX nit.
    const clipboard = sink.errors.filter(e => CLIPBOARD_RE.test(e))
    const resource4xx = sink.errors.filter(e => RESOURCE_4XX_RE.test(e))
    const other = sink.errors.filter(e => !CLIPBOARD_RE.test(e) && !RESOURCE_4XX_RE.test(e))

    if (resource4xx.length && !resource404Noticed) {
      resource404Noticed = true
      findings.push({
        title: 'Expected 4xx console noise from the unknown-slug / section probes',
        severity: 'Nit',
        category: 'UX',
        surface: 'Docs / unknown slug',
        repro: 'Navigate to #/docs/does-not-exist (and probe a non-artifact section); watch the console.',
        expected:
          'The app DOES handle these inline (the Docs viewer shows a not-found state) — but the raw "Failed to load resource: 404" still reaches the console.',
        actual: resource4xx[0],
        evidence: 'page.on("console") capture (expected, from the adversarial unknown-slug test).',
      })
    }
    if (clipboard.length && !bibleClipboardNoticed) {
      bibleClipboardNoticed = true
      findings.push({
        title: 'Bible "copy" button errors in Docs (sandbox blocks navigator.clipboard)',
        severity: 'Low',
        category: 'UX',
        surface: 'Docs / DocViewer',
        repro: 'Open #/docs (bible) and watch the console; the copy buttons use navigator.clipboard.',
        expected:
          'The compiled bible ships copy-to-clipboard buttons, but the DocViewer iframe is sandboxed without allow-same-origin, so clipboard writes throw in the null-origin frame.',
        actual: clipboard[0],
        evidence: 'page.on("console") capture',
      })
    }
    if (other.length) {
      findings.push({
        title: 'Unexpected console.error during the Docs/Help flow',
        severity: 'High',
        category: 'Bug',
        surface: 'Docs / Help',
        repro: 'Drive the Docs/Help flow with the console attached.',
        expected: 'No unexplained console.error in a clean session.',
        actual: other.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  writeFindings('P10', CHARTER, findings)
})

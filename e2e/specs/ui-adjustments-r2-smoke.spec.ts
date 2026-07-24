import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { captureConsole, gotoApp, screenshot, waitForWs, writeFindings, type ConsoleSink, type Finding } from '../lib/harness'
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// UI Adjustments ROUND 2 live smoke. Drives a real browser against the
// auto-booted, isolated stack to prove the Round 2 correction pass renders
// without crashes/regressions, with special focus on the two gaps Round 1
// (ui-adjustments-smoke.spec.ts, persona UIADJ) could not cover:
//   - the Knowledge Graph tab on POPULATED data (a hand-seeded .gitnexus/
//     graph.json on a throwaway fixture repo — never a real `gitnexus
//     analyze` build, which is slow/non-deterministic in this env), including
//     an in-SPA remount exercise (the fix targets re-arm-after-remount); and
//   - a REAL wallpaper image upload (not just the picker chrome).
//
// Also re-verifies, against the CURRENT (Round 2) testids/copy, the four
// surfaces Round 1 checked against now-stale assertions:
//   a. Home = Overview only (Chat|Overview split removed, D-129).
//   b. Message bar renders as a bare composer bar.
//   c. Runs: Agent Runs/Pipelines segments + the Active|Archived sub-segment
//      (replacing the old "Show archived" toggle) + bulk-select + the
//      permanent-delete confirm dialog (never actually confirmed).
//   d/e. Settings > Appearance: font-color picker, a real wallpaper upload,
//      the too-small-image warning, and the post-upload "Set background"
//      button label.
//
// Resilient per RUNBOOK.md: exploratory interactions are wrapped in try/catch
// and converted into `findings`; only the WS-connected boot (via gotoApp) is
// hard-asserted. writeFindings always runs so reports/UIADJ2.md exists.
//
// Run standalone:
//   pnpm exec playwright test --config e2e/playwright.config.ts \
//     specs/ui-adjustments-r2-smoke.spec.ts --reporter=list --trace off
// ===========================================================================

test.describe.configure({ mode: 'serial' })

const PERSONA = 'UIADJ2'
const CHARTER =
  'UI Adjustments Round 2 live smoke: Home=Overview-only, bare message bar, Runs consolidation ' +
  '(Active|Archived sub-segment + bulk delete confirm), Settings > Appearance (font color + REAL ' +
  'wallpaper upload + too-small warning + post-upload label), and the Knowledge Graph tab on ' +
  'POPULATED seeded data including an in-SPA remount exercise — the two gaps Round 1 could not cover.'

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

// --- Fixtures ----------------------------------------------------------------

/** Write a tiny (1x1) valid PNG to disk for the wallpaper upload test. Any small
 *  image reliably triggers the too-small-for-screen advisory warning. */
function writePngFixture(): string {
  const dir = path.resolve(__dirname, '..', '.fixtures', PERSONA)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'tiny.png')
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}

/** Hand-seed a `.gitnexus/graph.json` (the RAW file shape GET /api/projects/:id/graph
 *  reads directly — {nodes:[{id,label,type,group,...}], links:[{source,target,type}]},
 *  NOT the wire GraphResponse type) directly into a scratch repo, bypassing the slow
 *  and non-deterministic real `npx gitnexus analyze` build entirely. 4 nodes / 3 links
 *  — >=3 nodes so the UI's smallFleetCameraZ 1-2-node special case is never hit, and
 *  rendering only depends on `hasData = graph.nodes.length > 0`, independent of build
 *  meta.status (which stays 'idle' since buildGraph() is never called). */
function writeGraphFixture(repoPath: string): void {
  const dir = path.join(repoPath, '.gitnexus')
  fs.mkdirSync(dir, { recursive: true })
  const graph = {
    nodes: [
      { id: 'n1', name: 'index.js', label: 'index.js', type: 'File', file: 'index.js', group: 'File' },
      { id: 'n2', name: 'add', label: 'add', type: 'Function', file: 'index.js', group: 'Function' },
      { id: 'n3', name: 'README.md', label: 'README.md', type: 'File', file: 'README.md', group: 'File' },
      { id: 'n4', name: 'package.json', label: 'package.json', type: 'File', file: 'package.json', group: 'File' },
    ],
    links: [
      { source: 'n1', target: 'n2', type: 'CONTAINS' },
      { source: 'n2', target: 'n3', type: 'REFERENCES' },
      { source: 'n1', target: 'n4', type: 'CONTAINS' },
    ],
  }
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8')
}

/** Register a project via a direct in-page fetch (Vite's dev proxy auto-injects the
 *  Bearer HARNESS_TOKEN — same pattern P06.spec.ts already relies on for its GET
 *  call). Faster/more deterministic than driving the Register modal for this
 *  purpose since we only need a valid project id to seed graph data behind. */
async function registerProjectViaApi(page: Page, name: string, localPath: string): Promise<string | null> {
  return page.evaluate(async ({ name, localPath }) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, localPath }),
      })
      if (!res.ok) return null
      const project = (await res.json()) as { id?: string }
      return project.id ?? null
    } catch {
      return null
    }
  }, { name, localPath })
}

// --- a. Home = Overview only (D-129) -----------------------------------------

test('a. Home: Overview only, no Chat|Overview toggle', async ({ page }) => {
  await openApp(page, '#/home')
  await screenshot(page, 'r2-a-home-overview')

  try {
    await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('overview-customize')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Home does not render the Overview grid',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/home',
      repro: "gotoApp('#/home')",
      expected: 'An "Overview" h2 heading and the overview-customize toggle render.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-a-home-overview.png',
    })
  }

  // Regression check: the OLD Chats rail (chat-thread-rail) and any Chat|Overview
  // segmented toggle must be GONE — Home is Overview-only now (D-129).
  try {
    await expect(page.getByTestId('chat-thread-rail')).toHaveCount(0)
  } catch (err) {
    findings.push({
      title: 'Stale "chat-thread-rail" still present on Home',
      severity: 'High',
      category: 'Bug',
      surface: '#/home',
      repro: "gotoApp('#/home')",
      expected: 'chat-thread-rail (retired by D-129) is absent from Home.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-a-home-overview.png',
    })
  }

  try {
    const segCount = await page.locator('[data-testid^="seg-"]').count()
    if (segCount > 0) {
      findings.push({
        title: 'A segmented control (seg-*) is present on Home',
        severity: 'Med',
        category: 'Bug',
        surface: '#/home',
        repro: "gotoApp('#/home'); count [data-testid^=seg-]",
        expected: 'No Chat|Overview (or any other) segmented toggle on Home — Overview is the sole view.',
        actual: `Found ${segCount} seg-* element(s) on #/home.`,
        evidence: 'r2-a-home-overview.png',
      })
    }
  } catch { /* non-fatal probe */ }

  recordConsoleFindings('#/home')
})

// --- b. Message bar renders as a bare bar -------------------------------------

test('b. Message bar: composer renders as a bare bar', async ({ page }) => {
  await openApp(page, '#/home')

  try {
    await expect(page.getByTestId('dock-input')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('message-dock-bar')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Message bar (bar-variant composer) not visible on Home',
      severity: 'High',
      category: 'Bug',
      surface: '#/home',
      repro: "gotoApp('#/home')",
      expected: 'dock-input and its message-dock-bar chrome render inline on Home.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-b-message-bar.png',
    })
  }

  await screenshot(page, 'r2-b-message-bar')
  recordConsoleFindings('#/home (message bar)')
})

// --- c. Runs consolidation -----------------------------------------------------

test('c. Runs: segments, Active|Archived sub-segment, bulk-select + permanent-delete confirm', async ({ page }) => {
  await openApp(page, '#/runs')
  await screenshot(page, 'r2-c-runs')

  try {
    await expect(page.getByTestId('seg-agent')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('seg-pipelines')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Runs top-level segmented control missing Agent Runs / Pipelines',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs')",
      expected: 'seg-agent and seg-pipelines both render.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-c-runs.png',
    })
  }

  // Regression check: the OLD "Show archived" checkbox must be GONE, replaced by
  // the Active|Archived sub-segment.
  try {
    await expect(page.getByTestId('run-show-archived')).toHaveCount(0)
  } catch (err) {
    findings.push({
      title: 'Stale "run-show-archived" toggle still present on Runs',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs')",
      expected: 'run-show-archived (replaced by the Active|Archived sub-segment) is absent.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-c-runs.png',
    })
  }

  try {
    await expect(page.getByTestId('seg-exclude')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('seg-only')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Active|Archived sub-segment (seg-exclude/seg-only) missing on Runs',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs',
      repro: "gotoApp('#/runs')",
      expected: 'seg-exclude ("Active") and seg-only ("Archived") both render.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-c-runs.png',
    })
  }

  // Bulk-select + permanent-delete confirm — only exercisable if runs exist.
  try {
    const selectRows = page.locator('[data-testid^="run-select-"]')
    const n = await selectRows.count()
    if (n === 0) {
      findings.push({
        title: 'No runs seeded — bulk-select/permanent-delete flow not exercisable',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: '#/runs',
        repro: "gotoApp('#/runs')",
        expected: 'n/a — informational only.',
        actual: 'Fresh stack has no runs (Active segment), so no run-select-<id> checkbox exists to drive the bulk-select/delete flow.',
        evidence: 'r2-c-runs.png',
      })
    } else {
      await selectRows.first().click()
      const bulkBar = page.getByTestId('run-bulk-bar')
      await expect(bulkBar).toBeVisible({ timeout: 5_000 })
      await screenshot(page, 'r2-c-runs-bulk-bar')

      await page.getByTestId('run-bulk-delete').click()
      const dialog = page.getByTestId('run-bulk-delete-dialog')
      await expect(dialog).toBeVisible({ timeout: 5_000 })
      await expect(dialog).toContainText(/permanently/i)
      await screenshot(page, 'r2-c-runs-delete-dialog')

      // MUST NOT confirm — cancel out.
      await page.getByTestId('run-bulk-delete-dialog-cancel').click()
      await expect(dialog).toBeHidden({ timeout: 5_000 })
    }
  } catch (err) {
    findings.push({
      title: 'Runs bulk-select / permanent-delete confirm flow errored',
      severity: 'High',
      category: 'Bug',
      surface: '#/runs',
      repro: 'Check a run-select-<id> checkbox → run-bulk-bar → run-bulk-delete → run-bulk-delete-dialog → cancel.',
      expected: 'Selecting a run opens the floating bulk bar; Delete opens a permanent-delete ConfirmDialog; Cancel closes it without deleting.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-c-runs-bulk-bar.png / r2-c-runs-delete-dialog.png',
    })
  }

  recordConsoleFindings('#/runs')
})

// --- d/e. Settings > Appearance: font color, real wallpaper upload, warning ----
// Combined into one test (rather than two, per the a-f lettering) because the
// "Set background" button label is ONLY correct AFTER an image has been
// uploaded at least once (SettingsAppearance.tsx: hasImage = imageVersion !=
// null); checking that label pre-upload would assert against the WRONG state.

test('d/e. Settings > Appearance: font color, real wallpaper upload, size warning, Set-background label', async ({ page }) => {
  await openApp(page, '#/settings')
  const section = page.getByTestId('appearance-section')

  try {
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('font-color-input')).toBeVisible({ timeout: 10_000 })
    // ui-adjustments Round 4 dropped the gradient kind + <select>s in favour
    // of a Solid|Image SegControl (seg-solid/seg-image).
    await expect(page.getByTestId('seg-solid')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('seg-image')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Settings > Appearance panel (font color / background picker) did not render',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings',
      repro: "gotoApp('#/settings'); scroll to appearance-section",
      expected: 'appearance-section, font-color-input and the seg-solid/seg-image wallpaper-kind toggle all render.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-d-settings-appearance-before.png',
    })
  }
  await screenshot(page, 'r2-d-settings-appearance-before')

  // Real wallpaper upload via the hidden file input (setInputFiles works on a
  // sr-only-hidden <input type=file> regardless of visual visibility).
  try {
    const pngPath = writePngFixture()
    await page.setInputFiles('[data-testid="background-image-input"]', pngPath)

    const warning = page.getByTestId('background-size-warning')
    await expect(warning).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'r2-e-wallpaper-warning')

    // Let the upload mutation settle, then reload to confirm it persisted and
    // the wallpaper + glass actually render.
    await page.waitForTimeout(1500)
    await page.reload()
    await dismissHelp(page)
    await page.waitForTimeout(1000)
    await screenshot(page, 'r2-e-wallpaper-applied')

    // Post-upload state: kind should now be 'image' (seg-image pressed) and
    // the button should read "Set background" (hasImage flips true once
    // imageVersion is non-null).
    const section2 = page.getByTestId('appearance-section')
    await section2.scrollIntoViewIfNeeded()
    await expect(page.getByTestId('seg-image')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Set background' })).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'r2-d-settings-appearance-after')
  } catch (err) {
    findings.push({
      title: 'Real wallpaper upload flow (upload → warning → persist → "Set background" label) failed',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings (Appearance)',
      repro: 'Upload a small PNG via background-image-input; expect background-size-warning, then reload and expect kind=image + "Set background" label.',
      expected: 'Upload succeeds, the too-small warning appears, the wallpaper persists across reload, and the button now reads "Set background".',
      actual: String(err).slice(0, 300),
      evidence: 'r2-e-wallpaper-warning.png / r2-e-wallpaper-applied.png / r2-d-settings-appearance-after.png',
    })
  }

  recordConsoleFindings('#/settings (Appearance)')
})

// --- f. Knowledge Graph on POPULATED data (highest priority) -------------------

test('f. Knowledge Graph tab: populated render + in-SPA remount, hard-watch for crashes', async ({ page }) => {
  const repoPath = makeScratchRepo(PERSONA, 'kg-project')
  writeGraphFixture(repoPath)

  await openApp(page, '#/home') // any WS-connected page to run the registration fetch from
  const projectId = await registerProjectViaApi(page, 'r2-kg-project', repoPath)

  if (!projectId) {
    findings.push({
      title: 'Could not register the KG fixture project via POST /api/projects — populated-graph render NOT achieved',
      severity: 'High',
      category: 'Missing',
      surface: 'POST /api/projects',
      repro: `In-page fetch POST /api/projects {name:'r2-kg-project', localPath:'${repoPath}'}`,
      expected: 'Registration succeeds and returns a project id, so the seeded .gitnexus/graph.json can be rendered.',
      actual: 'registerProjectViaApi() returned null — see console/network for the actual failure.',
      evidence: 'n/a — registration failed before the KG tab could be opened.',
    })
    recordConsoleFindings('POST /api/projects (KG fixture)')
    return
  }

  // registerProjectViaApi is a raw in-page fetch(), bypassing the app's own
  // register-project mutation (and therefore its `['projects']` cache
  // invalidation). gotoApp()'s page.goto() to a hash-only-different URL does
  // NOT force a real document reload (browser fragment-navigation semantics —
  // confirmed via a network-level diagnostic: the app never re-fetched
  // ['projects'] on that "navigation"), so React Query would otherwise keep
  // serving the '#/home' mount's cached list (fetched moments ago, before
  // this project existed; staleTime: 5s) — producing a false "Project not
  // found" despite correct server state. Force a genuine reload landing
  // directly on the KG route so the app boots fresh and refetches — exactly
  // what a real user gets opening a fresh/bookmarked project URL (real users
  // hitting this route via in-app navigation go through the register
  // mutation, which DOES invalidate the cache, so this race is a fetch()
  // shortcut artifact, not an app bug).
  await page.evaluate((id) => { location.hash = `#/project/${id}/knowledge-graph` }, projectId)
  await page.reload()
  await waitForWs(page)
  await dismissHelp(page)

  // Hard-watch: give the two-phase mount + force layout a few seconds to settle,
  // then check for the render proof (a live, non-zero canvas) AND immediately
  // check console/page errors — this is the crash signature this test exists to catch.
  await page.waitForTimeout(3000)
  await screenshot(page, 'r2-f-kg-populated')

  try {
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible({ timeout: 10_000 })
    const box = await canvas.boundingBox()
    if (!box || box.width === 0 || box.height === 0) {
      findings.push({
        title: 'Knowledge Graph canvas rendered with zero size on populated data',
        severity: 'Critical',
        category: 'Bug',
        surface: `#/project/${projectId}/knowledge-graph`,
        repro: 'Register a project with a hand-seeded 4-node/3-link .gitnexus/graph.json; open its Knowledge Graph tab.',
        expected: 'A non-zero ForceGraph3D <canvas> renders the seeded nodes.',
        actual: JSON.stringify(box),
        evidence: 'r2-f-kg-populated.png',
      })
    }
  } catch (err) {
    findings.push({
      title: 'Knowledge Graph canvas did NOT render on populated data — CRASH SIGNATURE',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph`,
      repro: 'Register a project with a hand-seeded 4-node/3-link .gitnexus/graph.json; open its Knowledge Graph tab; wait 3s.',
      expected: 'A <canvas> (ForceGraph3D) renders the seeded nodes, not a blank pane.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-f-kg-populated.png',
    })
  }

  const errsBeforeRemount = sink.pageErrors.length
  const consoleBeforeRemount = sink.errors.length
  recordConsoleFindings(`#/project/${projectId}/knowledge-graph (initial populated mount)`)

  // --- In-SPA remount exercise (no full page reload) — the Round 2 fix targets
  // re-arm-after-remount for the auto-rotate rAF loop touching a torn-down graph
  // instance. Navigate away (hash-only, so React unmounts KnowledgeGraphTab via
  // ProjectWorkspace's `{t.id === 'knowledge-graph' && <KnowledgeGraphTab/>}`
  // conditional render) and back, then hard-watch again.
  try {
    await page.evaluate((id: string) => { location.hash = `#/project/${id}/overview` }, projectId)
    await page.waitForTimeout(800)
    await page.evaluate((id: string) => { location.hash = `#/project/${id}/knowledge-graph` }, projectId)
    await page.waitForTimeout(3000)
    await screenshot(page, 'r2-f-kg-remount')

    const canvasAfter = page.locator('canvas').first()
    await expect(canvasAfter).toBeVisible({ timeout: 10_000 })

    const newPageErrors = sink.pageErrors.slice(errsBeforeRemount)
    const newConsoleErrors = sink.errors.slice(consoleBeforeRemount)
    if (newPageErrors.length) {
      findings.push({
        title: 'Uncaught page error(s) after Knowledge Graph tab REMOUNT — re-arm-after-remount regression',
        severity: 'Critical',
        category: 'Bug',
        surface: `#/project/${projectId}/knowledge-graph (remount)`,
        repro: 'Open populated KG tab → navigate to Overview → navigate back to Knowledge Graph (hash-only, in-SPA) → wait 3s.',
        expected: 'No uncaught page errors after the remount (the auto-rotate rAF loop must null-guard/try-catch against the torn-down graph instance).',
        actual: newPageErrors.slice(0, 5).join(' | ').slice(0, 500),
        evidence: newPageErrors.join('\n').slice(0, 2000) + ' | r2-f-kg-remount.png',
      })
    }
    const fatalAfter = newConsoleErrors.filter(e => /AFRAME|is not defined|Cannot read|Minified React error/i.test(e))
    if (fatalAfter.length) {
      findings.push({
        title: 'Fatal console error(s) after Knowledge Graph tab REMOUNT',
        severity: 'High',
        category: 'Bug',
        surface: `#/project/${projectId}/knowledge-graph (remount)`,
        repro: 'Open populated KG tab → navigate to Overview → navigate back (in-SPA) → wait 3s.',
        expected: 'No fatal console errors after the remount.',
        actual: fatalAfter.slice(0, 5).join(' | ').slice(0, 500),
        evidence: fatalAfter.join('\n').slice(0, 2000),
      })
    }
  } catch (err) {
    findings.push({
      title: 'Knowledge Graph tab did not re-render after in-SPA remount',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph (remount)`,
      repro: 'Open populated KG tab → navigate to Overview → navigate back to Knowledge Graph (hash-only) → wait 3s.',
      expected: 'A live canvas re-renders after the remount.',
      actual: String(err).slice(0, 300),
      evidence: 'r2-f-kg-remount.png',
    })
  }
})

test.afterAll(() => {
  const file = writeFindings(PERSONA, CHARTER, findings)
  console.log(`[${PERSONA}] wrote ${findings.length} finding(s) to ${file}`)
})

import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { captureConsole, gotoApp, screenshot, timed, waitForWs, writeFindings, type ConsoleSink, type Finding } from '../lib/harness'
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// UI Adjustments ROUND 3 (D-134) live smoke. Drives a real browser against the
// auto-booted, isolated stack to prove the Round 3 correction pass renders
// without crashes/regressions. Eight surfaces, each with an assertion +
// screenshot where visual:
//   1. Glass renders over BOTH a gradient wallpaper and a REAL uploaded PNG
//      image wallpaper (Home + a panel-heavy page under each).
//   2. The ConversationView composer's `.glass-bar` wrapper is a real,
//      visible surface (D-134 fixed a Round-2 regression where it shipped
//      with no background — "the bar disappeared").
//   3. No stray "orchestrator" conversation is listed (server SQL excludes
//      default-orchestrator; client also filters it) — checked via both a
//      direct GET /api/conversations and the rendered Messages rows.
//   4. The terminal is fully removed: no workspace tab, `#/terminal` resolves
//      to the app's own 404 (not a live terminal view), and Settings has no
//      terminal/diagnostics section.
//   5. The Knowledge Graph tab does not freeze on a MODERATE populated graph
//      (64 nodes / ~95 links — big enough that the old synchronous 300-tick
//      warmup would have been noticeable), exercising the off-thread worker
//      + two-phase mount path: overlay appears then clears, canvas renders,
//      the page stays responsive, and mount + an in-SPA remount are both
//      clean (zero uncaught page errors, hard-asserted).
//   6. The Settings side-nav sits in its own distinct glass panel container
//      (non-transparent background + hairline border), not floating bare on
//      the page background.
//   7. The Home Message Dock ("the main K message bar") renders as a visible
//      bar: `message-dock-bar` (the footer) and `dock-input` are both
//      visible, `message-dock-bar` computes to `position:relative`/`zIndex:10`
//      (lifted above the fixed z-0 wallpaper — the actual paint fix; a plain
//      `toBeVisible()` alone does NOT catch the wallpaper painting over the
//      footer's content, since Playwright's visibility check ignores paint
//      order), and `dock-input` sits inside a real `.glass-bar` surface with a
//      non-transparent background — the fix for the operator-reported
//      regression where the wallpaper occluded everything but the Send
//      button (its own escaped stacking context). Hard-asserted because this
//      is the specific regression the round exists to prove fixed.
//   8. The corner-K `dock-fab` is suppressed entirely on Messages and
//      Settings (both routes have their own composer / no dock use case) —
//      proven absent there, and still present on a normal route (`personal`)
//      to show the suppression is scoped to exactly those two routes, not a
//      global regression. Hard-asserted and placed last, so a real
//      regression fails loudly without skipping tests 1-7.
//
// Resilient per RUNBOOK.md: exploratory interactions are wrapped in try/catch
// and converted into `findings`; only the fundamentals (WS-connected boot,
// zero uncaught page errors across the KG mount+remount) are hard-asserted.
// writeFindings always runs so reports/UIADJ3.md exists.
//
// Run standalone (own isolated port pair, NOT the shared 3001/5173 defaults):
//   CORE_PORT=3113 WEB_PORT=4113 PERSONA=UIADJ3 pnpm exec playwright test \
//     --config e2e/playwright.config.ts specs/ui-adjustments-r3-smoke.spec.ts \
//     --reporter=list --trace off
// ===========================================================================

test.describe.configure({ mode: 'serial' })

const PERSONA = 'UIADJ3'
const CHARTER =
  'UI Adjustments Round 3 (D-134) live smoke: glass over both a gradient AND a real uploaded image ' +
  'wallpaper, the ConversationView .glass-bar composer regression fix, no stray "orchestrator" ' +
  'conversation (server+client exclusion), full terminal removal (tab/route/settings), the ' +
  'Knowledge Graph off-thread-worker/LOD path on a MODERATE (64-node) populated graph with a ' +
  'hard-asserted zero-uncaught-error mount+remount, the Settings side-nav\'s own glass panel, ' +
  'the Home Message Dock bar rendering as a visible .glass-bar surface lifted (relative/z-10) ' +
  'above the wallpaper (operator-reported "message bar not rendering" regression fix), and the ' +
  'corner-K dock-fab suppressed on Messages/Settings only (still present elsewhere).'

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

/** Draw a real, colorful gradient PNG on an in-browser <canvas> and encode it via
 *  the browser's own `toDataURL('image/png')` — guarantees byte-valid PNG output
 *  without hand-rolling a zlib/CRC32 encoder, and (unlike R2's 1x1 stub) is large
 *  and visually distinctive enough to eyeball in a screenshot. Needs an
 *  already-loaded page (any route — canvas creation is route-independent). */
async function makeCanvasPngFixture(page: Page, name: string): Promise<string> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 640
    c.height = 400
    const ctx = c.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 640, 400)
    grad.addColorStop(0, '#ff2d95')
    grad.addColorStop(0.5, '#7c3aed')
    grad.addColorStop(1, '#38bdf8')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 640, 400)
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = 'bold 44px sans-serif'
    ctx.fillText('R3 WALLPAPER', 36, 220)
    return c.toDataURL('image/png')
  })
  const dir = path.resolve(__dirname, '..', '.fixtures', PERSONA)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  const base64 = dataUrl.split(',')[1]
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

/** Hand-seed a MODERATE `.gitnexus/graph.json` (same raw shape R2 used — the file
 *  GET /api/projects/:id/graph reads directly, {nodes, links}, not the wire
 *  GraphResponse type): 64 nodes / ~95 links. Deliberately sized well above the
 *  old GRAPH_WARMUP_TICKS=300 sync-freeze's noticeable range, but well under
 *  LOD_NODE_CAP=1500 — big enough to exercise the off-thread worker's real
 *  layout-compute path without ever engaging the LOD cap. A guaranteed-connected
 *  chain (n[i-1]->n[i]) plus a deterministic (no RNG flake) extra-edge pass to
 *  reach the target link count. */
function writeModerateGraphFixture(repoPath: string): void {
  const dir = path.join(repoPath, '.gitnexus')
  fs.mkdirSync(dir, { recursive: true })
  const NODE_COUNT = 64
  const types = ['File', 'Function'] as const
  const nodes = Array.from({ length: NODE_COUNT }, (_, i) => {
    const type = types[i % types.length]
    return {
      id: `n${i}`,
      name: `${type.toLowerCase()}_${i}`,
      label: `${type.toLowerCase()}_${i}`,
      file: `src/mod${i % 12}.ts`,
      type,
      group: type,
    }
  })
  const links: { source: string; target: string; type: string }[] = []
  for (let i = 1; i < NODE_COUNT; i++) {
    links.push({ source: `n${i - 1}`, target: `n${i}`, type: i % 2 === 0 ? 'CONTAINS' : 'REFERENCES' })
  }
  for (let i = 0; i < NODE_COUNT; i += 2) {
    const target = (i + 7) % NODE_COUNT
    if (target !== i) links.push({ source: `n${i}`, target: `n${target}`, type: 'CALLS' })
  }
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ nodes, links }, null, 2), 'utf8')
}

/** Register a project via a direct in-page fetch (Vite's dev proxy auto-injects the
 *  Bearer HARNESS_TOKEN). Faster/more deterministic than driving the Register modal. */
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

// --- 1. Glass over both backgrounds -------------------------------------------

test('1. Glass renders over both a gradient background and a real uploaded image wallpaper', async ({ page }) => {
  await openApp(page, '#/settings')
  const section = page.getByTestId('appearance-section')

  try {
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible({ timeout: 10_000 })
    await page.selectOption('[data-testid="background-kind-select"]', 'gradient')
    await expect(page.getByTestId('background-preset-select')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="app-background"]')).toHaveAttribute('data-variant', 'gradient', { timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Could not switch wallpaper to the gradient kind',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings (Appearance)',
      repro: "selectOption background-kind-select -> 'gradient'",
      expected: 'app-background flips to data-variant=gradient.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-1-home-gradient.png',
    })
  }

  await openApp(page, '#/home')
  await screenshot(page, 'r3-1-home-gradient')
  await openApp(page, '#/messages')
  await screenshot(page, 'r3-1-messages-gradient')

  try {
    const pngPath = await makeCanvasPngFixture(page, 'wallpaper')
    await openApp(page, '#/settings')
    await page.getByTestId('appearance-section').scrollIntoViewIfNeeded()
    await page.setInputFiles('[data-testid="background-image-input"]', pngPath)
    await page.waitForTimeout(1500)
    await page.reload()
    await dismissHelp(page)
    await page.getByTestId('appearance-section').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('background-kind-select')).toHaveValue('image', { timeout: 10_000 })
    await expect(page.locator('[data-testid="app-background"]')).toHaveAttribute('data-variant', 'image', { timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Real PNG wallpaper upload did not switch the live background to "image"',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings (Appearance)',
      repro: 'Upload a real browser-canvas-encoded PNG via background-image-input; reload.',
      expected: 'background-kind-select reads "image" and app-background flips to data-variant=image.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-1-home-image.png',
    })
  }

  await openApp(page, '#/home')
  await screenshot(page, 'r3-1-home-image')
  await openApp(page, '#/messages')
  await screenshot(page, 'r3-1-messages-image')

  recordConsoleFindings('#/settings + #/home + #/messages (backgrounds)')
})

// --- 2. Message bar visible ----------------------------------------------------

test('2. Message bar: ConversationView composer renders as a visible glass-bar (D-134 regression fix)', async ({ page }) => {
  await openApp(page, '#/messages')

  try {
    const rows = page.locator('[data-testid^="messages-row-"]')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    await rows.first().click()
    await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 10_000 })

    const bar = page.locator('.glass-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('conversation-composer-input')).toBeVisible({ timeout: 10_000 })

    const bg = await bar.evaluate(el => getComputedStyle(el).backgroundColor)
    if (bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(bg)) {
      findings.push({
        title: 'ConversationView composer .glass-bar resolves to a transparent background',
        severity: 'Critical',
        category: 'Bug',
        surface: '#/messages (conversation composer)',
        repro: 'Open any agent conversation; read getComputedStyle(.glass-bar).backgroundColor',
        expected: 'A non-transparent rgba (var(--glass-2)) — the D-134 fix for the Round-2 "bar disappeared" regression.',
        actual: bg,
        evidence: 'r3-2-message-bar-hover.png',
      })
    }

    await bar.hover()
    await screenshot(page, 'r3-2-message-bar-hover')

    await page.getByTestId('conversation-composer-input').click()
    await screenshot(page, 'r3-2-message-bar-focus')
  } catch (err) {
    findings.push({
      title: 'Message bar (ConversationView composer) not visible / not a real surface',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/messages (conversation composer)',
      repro: 'Open #/messages, click the first conversation row.',
      expected: '.glass-bar wrapper + conversation-composer-input both visible with a real (non-transparent) background.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-2-message-bar-hover.png',
    })
  }

  recordConsoleFindings('#/messages (message bar)')
})

// --- 3. No stray "orchestrator" conversation ------------------------------------

test('3. No stray "orchestrator" conversation is listed (server + client dual exclusion)', async ({ page }) => {
  await openApp(page, '#/messages')

  try {
    const conversations = await page.evaluate(async () => {
      const res = await fetch('/api/conversations?archived=1')
      if (!res.ok) throw new Error(`GET /api/conversations -> ${res.status}`)
      const body = (await res.json()) as { conversations: Array<{ profileId: string; profileName?: string; title?: string | null }> }
      return body.conversations
    })

    const stray = conversations.filter(c =>
      c.profileId === 'default-orchestrator' ||
      (c.profileName ?? '').trim().toLowerCase() === 'orchestrator' ||
      (c.title ?? '').trim().toLowerCase() === 'orchestrator',
    )
    if (stray.length) {
      findings.push({
        title: 'GET /api/conversations includes a stray "orchestrator" conversation',
        severity: 'Critical',
        category: 'Bug',
        surface: 'GET /api/conversations',
        repro: 'fetch /api/conversations?archived=1',
        expected: 'No row with profileId=default-orchestrator or a profileName/title rendering as "orchestrator".',
        actual: JSON.stringify(stray).slice(0, 500),
        evidence: JSON.stringify(conversations).slice(0, 1000),
      })
    }
  } catch (err) {
    findings.push({
      title: 'Could not verify /api/conversations exclusion of default-orchestrator',
      severity: 'Med',
      category: 'Bug',
      surface: 'GET /api/conversations',
      repro: 'fetch /api/conversations?archived=1',
      expected: 'A 200 response with a conversations array.',
      actual: String(err).slice(0, 300),
      evidence: 'n/a',
    })
  }

  try {
    const rowTexts = await page.locator('[data-testid^="messages-row-"]').allTextContents()
    const strayRow = rowTexts.find(t => t.trim().toLowerCase() === 'orchestrator')
    if (strayRow !== undefined) {
      findings.push({
        title: 'A Messages row renders literally as "orchestrator"',
        severity: 'Critical',
        category: 'Bug',
        surface: '#/messages',
        repro: 'Open #/messages, read all messages-row-* text content.',
        expected: 'No row text is exactly "orchestrator" (default-orchestrator profile must be excluded client + server side).',
        actual: JSON.stringify(rowTexts).slice(0, 500),
        evidence: 'r3-3-messages-list.png',
      })
    } else if (rowTexts.length === 0) {
      findings.push({
        title: 'No conversations listed on #/messages — orchestrator-exclusion check has no rows to examine',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: '#/messages',
        repro: 'Open #/messages',
        expected: 'n/a — informational only.',
        actual: 'messages-row-* count was 0.',
        evidence: 'r3-3-messages-list.png',
      })
    }
  } catch (err) {
    findings.push({
      title: 'Could not read Messages row list for the orchestrator-exclusion check',
      severity: 'Low',
      category: 'Bug',
      surface: '#/messages',
      repro: 'allTextContents() on messages-row-*',
      expected: 'Row texts are readable.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-3-messages-list.png',
    })
  }

  await screenshot(page, 'r3-3-messages-list')
  recordConsoleFindings('#/messages (orchestrator exclusion)')
})

// --- 4. Terminal gone -----------------------------------------------------------

test('4. Terminal is fully removed: no workspace tab, no #/terminal route, no Settings section', async ({ page }) => {
  const repoPath = makeScratchRepo(PERSONA, 'terminal-check-project')
  await openApp(page, '#/home')
  const projectId = await registerProjectViaApi(page, 'r3-terminal-check', repoPath)

  if (!projectId) {
    findings.push({
      title: 'Could not register a project via POST /api/projects for the terminal-removal check',
      severity: 'Med',
      category: 'Missing',
      surface: 'POST /api/projects',
      repro: `In-page fetch POST /api/projects {name:'r3-terminal-check', localPath:'${repoPath}'}`,
      expected: 'Registration succeeds and returns a project id.',
      actual: 'registerProjectViaApi() returned null.',
      evidence: 'n/a',
    })
  } else {
    await page.evaluate((id) => { location.hash = `#/project/${id}/overview` }, projectId)
    await page.reload()
    await waitForWs(page)
    await dismissHelp(page)

    try {
      const tabs = page.locator('[role="tablist"][aria-label="Project workspace tabs"] [role="tab"]')
      const labels = await tabs.allTextContents()
      const hasTerminalTab = labels.some(l => /terminal/i.test(l))
      if (hasTerminalTab) {
        findings.push({
          title: 'A "Terminal" tab is still present in the project workspace',
          severity: 'Critical',
          category: 'Bug',
          surface: `#/project/${projectId}/overview`,
          repro: 'Open a project workspace, read the tab bar labels.',
          expected: 'Tab labels are exactly: Overview, Knowledge Graph, Runs, Tasks, PRs & CI, Verification, Artifacts — no Terminal.',
          actual: JSON.stringify(labels),
          evidence: 'r3-4-workspace-tabs.png',
        })
      }
      await screenshot(page, 'r3-4-workspace-tabs')
    } catch (err) {
      findings.push({
        title: 'Could not read the project workspace tab bar',
        severity: 'Med',
        category: 'Bug',
        surface: `#/project/${projectId}/overview`,
        repro: 'Read [role=tablist] tab labels',
        expected: 'Tab labels are readable.',
        actual: String(err).slice(0, 300),
        evidence: 'r3-4-workspace-tabs.png',
      })
    }
  }

  try {
    await page.evaluate(() => { location.hash = '#/terminal' })
    await page.waitForTimeout(500)
    await expect(page.getByTestId('route-404')).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'r3-4-terminal-route-404')
  } catch (err) {
    findings.push({
      title: '#/terminal does not render the app 404 — may resolve to a live terminal view',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/terminal',
      repro: "location.hash = '#/terminal'",
      expected: 'The 404 route-404 view renders (terminal is not a KNOWN_VIEW).',
      actual: String(err).slice(0, 300),
      evidence: 'r3-4-terminal-route-404.png',
    })
  }

  try {
    await openApp(page, '#/settings')
    const bodyText = await page.locator('body').innerText()
    if (/built-in terminal|diagnostics terminal/i.test(bodyText)) {
      findings.push({
        title: 'Settings still references a built-in/diagnostics terminal section',
        severity: 'High',
        category: 'Bug',
        surface: '#/settings',
        repro: 'Open #/settings, search body text for /built-in terminal|diagnostics terminal/i',
        expected: 'No terminal-related section text anywhere on Settings.',
        actual: 'Matched terminal-related text on the Settings page.',
        evidence: 'r3-4-settings-no-terminal.png',
      })
    }
    await screenshot(page, 'r3-4-settings-no-terminal')
  } catch (err) {
    findings.push({
      title: 'Could not scan Settings page text for terminal references',
      severity: 'Low',
      category: 'Bug',
      surface: '#/settings',
      repro: 'Read body innerText on #/settings',
      expected: 'Body text is readable.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-4-settings-no-terminal.png',
    })
  }

  recordConsoleFindings('#/project/*/overview + #/terminal + #/settings (terminal removal)')
})

// --- 5. Knowledge Graph: populated, no-freeze, mount + remount clean -----------

test('5. Knowledge Graph: off-thread layout on a moderate populated graph, no freeze, clean mount + remount', async ({ page }) => {
  const repoPath = makeScratchRepo(PERSONA, 'kg-moderate-project')
  writeModerateGraphFixture(repoPath)

  await openApp(page, '#/home')
  const projectId = await registerProjectViaApi(page, 'r3-kg-moderate', repoPath)

  if (!projectId) {
    findings.push({
      title: 'Could not register the moderate-graph fixture project via POST /api/projects',
      severity: 'Critical',
      category: 'Missing',
      surface: 'POST /api/projects',
      repro: `In-page fetch POST /api/projects {name:'r3-kg-moderate', localPath:'${repoPath}'}`,
      expected: 'Registration succeeds and returns a project id.',
      actual: 'registerProjectViaApi() returned null.',
      evidence: 'n/a',
    })
    recordConsoleFindings('POST /api/projects (KG moderate fixture)')
    return
  }

  await page.evaluate((id) => { location.hash = `#/project/${id}/knowledge-graph` }, projectId)
  await page.reload()
  await waitForWs(page)
  await dismissHelp(page)

  const overlay = page.getByTestId('kg-layout-overlay')
  const overlaySeen = await overlay.isVisible().catch(() => false)

  try {
    await expect(overlay).toHaveCount(0, { timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'kg-layout-overlay ("Computing layout…") never cleared on a populated graph',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph`,
      repro: 'Register a 64-node/~95-link .gitnexus/graph.json project; open its Knowledge Graph tab; wait up to 10s.',
      expected: 'The overlay disappears once forcesReady && layoutReady (the off-thread worker resolved, or the 4s watchdog fired the sync fallback).',
      actual: String(err).slice(0, 300),
      evidence: 'r3-5-kg-populated.png',
    })
  }

  try {
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible({ timeout: 10_000 })
    const box = await canvas.boundingBox()
    if (!box || box.width === 0 || box.height === 0) {
      findings.push({
        title: 'Knowledge Graph canvas rendered with zero size on the moderate populated graph',
        severity: 'Critical',
        category: 'Bug',
        surface: `#/project/${projectId}/knowledge-graph`,
        repro: 'Open KG tab with a 64-node fixture graph.',
        expected: 'A non-zero ForceGraph3D canvas renders.',
        actual: JSON.stringify(box),
        evidence: 'r3-5-kg-populated.png',
      })
    }
  } catch (err) {
    findings.push({
      title: 'Knowledge Graph canvas did NOT render on the moderate populated graph — CRASH SIGNATURE',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph`,
      repro: 'Open KG tab with a 64-node fixture graph; wait up to 10s.',
      expected: 'A <canvas> renders the seeded nodes.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-5-kg-populated.png',
    })
  }

  await screenshot(page, 'r3-5-kg-populated')

  try {
    const filter = page.getByPlaceholder(/filter/i)
    const { ms } = await timed(async () => {
      await filter.click({ timeout: 5_000 })
      await filter.fill('n1', { timeout: 5_000 })
    })
    if (ms > 4_000) {
      findings.push({
        title: 'Knowledge Graph UI was slow to respond to input during/after layout',
        severity: 'High',
        category: 'Perf',
        surface: `#/project/${projectId}/knowledge-graph`,
        repro: 'Click + fill the node filter input right after opening a populated KG tab.',
        expected: 'Interaction handled within a short budget (main thread never blocked by layout).',
        actual: `${ms}ms`,
        evidence: 'r3-5-kg-populated.png',
      })
    }
    await filter.fill('')
  } catch (err) {
    findings.push({
      title: 'Could not run the KG responsiveness probe (filter input)',
      severity: 'Low',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph`,
      repro: 'Click/fill the node filter input.',
      expected: 'The filter input is interactable.',
      actual: String(err).slice(0, 300),
      evidence: 'n/a',
    })
  }

  const errsBeforeRemount = sink.pageErrors.length
  const consoleBeforeRemount = sink.errors.length
  recordConsoleFindings(`#/project/${projectId}/knowledge-graph (initial mount, overlaySeen=${overlaySeen})`)

  try {
    await page.evaluate((id: string) => { location.hash = `#/project/${id}/overview` }, projectId)
    await page.waitForTimeout(500)
    await page.evaluate((id: string) => { location.hash = `#/project/${id}/knowledge-graph` }, projectId)

    const overlayAfter = page.getByTestId('kg-layout-overlay')
    await expect(overlayAfter).toHaveCount(0, { timeout: 10_000 })
    const canvasAfter = page.locator('canvas').first()
    await expect(canvasAfter).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'r3-5-kg-remount')
  } catch (err) {
    findings.push({
      title: 'Knowledge Graph tab did not cleanly re-render after in-SPA remount (moderate graph)',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph (remount)`,
      repro: 'Open populated KG tab, navigate to Overview, navigate back (hash-only).',
      expected: 'The overlay clears again and a live canvas re-renders.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-5-kg-remount.png',
    })
  }

  const newPageErrors = sink.pageErrors.slice(errsBeforeRemount)
  const newConsoleErrors = sink.errors.slice(consoleBeforeRemount).filter(e => /AFRAME|is not defined|Cannot read|Minified React error/i.test(e))
  if (newPageErrors.length || newConsoleErrors.length) {
    findings.push({
      title: 'Uncaught/fatal error(s) after Knowledge Graph remount on the moderate populated graph',
      severity: 'Critical',
      category: 'Bug',
      surface: `#/project/${projectId}/knowledge-graph (remount)`,
      repro: 'Open populated KG tab, navigate away, navigate back (hash-only, in-SPA).',
      expected: 'Zero uncaught page errors and zero fatal console errors after the remount.',
      actual: [...newPageErrors, ...newConsoleErrors].slice(0, 5).join(' | ').slice(0, 500),
      evidence: 'r3-5-kg-remount.png',
    })
  }

  // Hard requirement (per D-134 verification charter): ZERO uncaught page
  // errors across BOTH the initial populated mount and the in-SPA remount.
  expect(sink.pageErrors, `Uncaught page error(s) across KG mount+remount: ${sink.pageErrors.join(' | ')}`).toEqual([])
})

// --- 6. Settings side-nav in its own glass panel --------------------------------

test('6. Settings side-nav sits in its own glass panel container', async ({ page }) => {
  await openApp(page, '#/settings')

  try {
    const nav = page.locator('nav[aria-label="Settings sections"]')
    await expect(nav).toBeVisible({ timeout: 10_000 })

    const bg = await nav.evaluate(el => getComputedStyle(el).backgroundColor)
    const isTransparent = bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(bg)
    if (isTransparent) {
      findings.push({
        title: 'Settings side-nav has no distinct background — floats bare on the page background',
        severity: 'High',
        category: 'Bug',
        surface: '#/settings',
        repro: 'Read getComputedStyle(nav[aria-label="Settings sections"]).backgroundColor',
        expected: 'A non-transparent background (var(--glass-2)) distinguishing the nav as its own panel.',
        actual: bg,
        evidence: 'r3-6-settings-nav.png',
      })
    }

    const hasBorder = await nav.evaluate(el => {
      const s = getComputedStyle(el)
      return s.borderWidth !== '0px' && s.borderStyle !== 'none'
    })
    if (!hasBorder) {
      findings.push({
        title: 'Settings side-nav has no visible border/hairline',
        severity: 'Med',
        category: 'Bug',
        surface: '#/settings',
        repro: 'Read getComputedStyle(nav[aria-label="Settings sections"]).borderWidth/borderStyle',
        expected: 'A hairline border (var(--glass-tier-border)) framing the nav panel.',
        actual: 'no border detected',
        evidence: 'r3-6-settings-nav.png',
      })
    }

    await nav.screenshot({ path: path.resolve(__dirname, '..', 'reports', 'screens', 'r3-6-settings-nav-cropped.png') })
  } catch (err) {
    findings.push({
      title: 'Settings side-nav (nav[aria-label="Settings sections"]) not found/visible',
      severity: 'High',
      category: 'Bug',
      surface: '#/settings',
      repro: "gotoApp('#/settings')",
      expected: 'The desktop settings side-nav renders as its own glass panel.',
      actual: String(err).slice(0, 300),
      evidence: 'r3-6-settings-nav.png',
    })
  }

  await screenshot(page, 'r3-6-settings-nav')
  recordConsoleFindings('#/settings (side-nav panel)')
})

// --- 7. Home Message Dock bar visible (operator-reported regression fix) -------
//
// The operator reported "the main K message bar is not rendering." A first fix
// attempt (adding `.glass-bar` to the input row alone) did NOT fix it visually:
// the footer sat in normal flow BEHIND the fixed z-0 wallpaper (outside Shell's
// `<main className="relative z-10">`), so the wallpaper painted over the
// composer's content — only the Send button (its own escaped stacking context)
// showed. The real fix lifts the footer itself: `<footer data-testid=
// "message-dock-bar" className="relative z-10 ...">` (MessageDock.tsx), on top
// of the `.glass-bar` input-row wrapper (matching the ConversationView composer
// fix verified in test 2 above). The dock renders `variant="bar"` only on Home
// (`route.view === 'home'`, Shell.tsx) — everywhere else it's the floating
// `variant="float"` fab, so this must specifically drive `#/home`.
//
// Hard-asserted (not the try/catch->findings pattern used elsewhere in this
// file) so a real regression fails this test loudly without skipping the other
// six in the `serial` run — this is the exact bug the round exists to prove
// fixed, so a silent findings-only record isn't enough. Test 8 (corner-K
// suppression) follows it, also hard-asserted.

test('7. Home Message Dock: dock-bar renders as a visible glass-bar surface (message-bar-not-rendering fix)', async ({ page }) => {
  await openApp(page, '#/home')

  const dockBar = page.getByTestId('message-dock-bar')
  await expect(dockBar).toBeVisible({ timeout: 10_000 })
  const dockInput = page.getByTestId('dock-input')
  await expect(dockInput).toBeVisible({ timeout: 10_000 })

  // The paint fix itself: message-dock-bar must be lifted into its own stacking
  // context ABOVE the fixed z-0 wallpaper (`relative z-10`, matching Shell's
  // `<main className="relative z-10">`). Without this the footer sits in normal
  // flow BEHIND the wallpaper, which paints over the composer's content — only
  // the Send button (its own stacking context) escaped. This is the exact
  // regression a DOM-visibility-only check (below) cannot catch: `toBeVisible()`
  // passes even when the wallpaper is painting over the element, because
  // Playwright's visibility check doesn't account for a sibling with a higher
  // paint order occluding it. Asserting the computed style directly closes that
  // gap.
  const dockBarStyle = await dockBar.evaluate(el => {
    const s = getComputedStyle(el)
    return { position: s.position, zIndex: s.zIndex }
  })
  expect(dockBarStyle.position, 'message-dock-bar must be position:relative (paint-order fix)').toBe('relative')
  expect(dockBarStyle.zIndex, 'message-dock-bar must be zIndex:10 (lifted above the z-0 wallpaper)').toBe('10')

  // Walk up from dock-input to the nearest ancestor carrying `.glass-bar` and
  // read its computed background — proves the input row is a real surface,
  // not the invisible regression (bare input, no wrapper background).
  const glassBar = await dockInput.evaluate(el => {
    let node: HTMLElement | null = el.parentElement
    while (node) {
      if (node.classList.contains('glass-bar')) {
        return { found: true, bg: getComputedStyle(node).backgroundColor }
      }
      node = node.parentElement
    }
    return { found: false, bg: '' }
  })

  expect(glassBar.found, 'dock-input must sit inside a .glass-bar ancestor (the dock-bar regression fix)').toBe(true)
  const isTransparent = glassBar.bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(glassBar.bg)
  expect(
    isTransparent,
    `.glass-bar wrapping dock-input resolved to a transparent background (${glassBar.bg}) — ` +
      'the operator-reported "message bar not rendering" regression (only Send would be visible).',
  ).toBe(false)

  // Full-width crop of the bottom bar (falls back to a full-page shot if the
  // locator screenshot fails for any reason — the bar must still be in frame).
  const screensDir = path.resolve(__dirname, '..', 'reports', 'screens')
  fs.mkdirSync(screensDir, { recursive: true })
  try {
    await dockBar.screenshot({ path: path.join(screensDir, 'r3-7-k-dock-bar.png') })
  } catch {
    await page.screenshot({ path: path.join(screensDir, 'r3-7-k-dock-bar.png'), fullPage: true })
  }

  // Hover + focus the input to show the pink-purple ring (.glass-bar:hover /
  // :focus-within, index.css) — same surface, interactive state.
  await dockInput.hover()
  await dockInput.focus()
  try {
    await dockBar.screenshot({ path: path.join(screensDir, 'r3-7-k-dock-bar-focus.png') })
  } catch {
    await page.screenshot({ path: path.join(screensDir, 'r3-7-k-dock-bar-focus.png'), fullPage: true })
  }

  recordConsoleFindings('#/home (Message Dock bar)')
})

// --- 8. Corner-K dock-fab suppressed on Messages + Settings only ---------------
//
// Shell.tsx now suppresses <MessageDock> entirely on the `messages` and
// `settings` routes (`route.view !== 'messages' && route.view !== 'settings'`)
// — both have their own composer / no dock use case, so the floating corner-K
// fab there was redundant/unwanted. Proves the fab (and the bar) are gone on
// BOTH of those routes, and that a normal, unrelated route (`personal`) still
// gets the fab — the suppression is scoped to exactly the two intended routes,
// not a global regression that would silently kill the dock everywhere.
//
// Hard-asserted (same rationale as test 7) and placed last so a real
// regression fails loudly without skipping the earlier tests.

test('8. Corner-K dock-fab is suppressed on Messages + Settings only, still present elsewhere', async ({ page }) => {
  const screensDir = path.resolve(__dirname, '..', 'reports', 'screens')
  fs.mkdirSync(screensDir, { recursive: true })

  // --- Home: definitive visual proof the dock bar paints its full content
  // (⚡ spark, "Message K…" placeholder, Send) — not just the Send button. ---
  await openApp(page, '#/home')
  const homeDockBar = page.getByTestId('message-dock-bar')
  await expect(homeDockBar).toBeVisible({ timeout: 10_000 })
  try {
    await homeDockBar.screenshot({ path: path.join(screensDir, 'r3-8-k-dock-fixed.png') })
  } catch {
    await page.screenshot({ path: path.join(screensDir, 'r3-8-k-dock-fixed.png'), fullPage: true })
  }

  // --- Messages: no corner-K fab (it has its own per-conversation composer,
  // test 2), and no bar variant either. ---
  await openApp(page, '#/messages')
  await expect(page.getByTestId('dock-fab')).toHaveCount(0)
  await expect(page.getByTestId('message-dock-bar')).toHaveCount(0)
  const vp = page.viewportSize()
  if (vp) {
    // Clipped to the bottom-right quadrant (where the fab would float,
    // `fixed bottom-4 right-4`) — easy to eyeball its absence directly.
    await page.screenshot({
      path: path.join(screensDir, 'r3-8-messages-no-fab.png'),
      clip: { x: Math.max(0, vp.width - 260), y: Math.max(0, vp.height - 260), width: 260, height: 260 },
    })
  } else {
    await page.screenshot({ path: path.join(screensDir, 'r3-8-messages-no-fab.png'), fullPage: true })
  }

  // --- Settings: same suppression. ---
  await openApp(page, '#/settings')
  await expect(page.getByTestId('dock-fab')).toHaveCount(0)
  await expect(page.getByTestId('message-dock-bar')).toHaveCount(0)

  // --- Control: a normal, unrelated route still gets the floating fab —
  // proves the suppression above is scoped, not a global dock regression. ---
  await openApp(page, '#/personal')
  await expect(page.getByTestId('dock-fab')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('message-dock-bar')).toHaveCount(0)

  recordConsoleFindings('#/home + #/messages + #/settings + #/personal (corner-K suppression scope)')
})

test.afterAll(() => {
  const file = writeFindings(PERSONA, CHARTER, findings)
  console.log(`[${PERSONA}] wrote ${findings.length} finding(s) to ${file}`)
})

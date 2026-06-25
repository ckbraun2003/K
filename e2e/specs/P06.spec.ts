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
// P06 — Knowledge Graph
// Charter: Fleet Graph (#/graph) + Home fleet graph + a project's Knowledge
// Graph tab. CRITICAL focus: the ForceGraph canvas must actually RENDER (no
// blank screen, no AFRAME/console error — the repo's known footgun where the
// aggregate `react-force-graph` import throws ReferenceError: AFRAME at module
// eval). Register fixtures so the fleet graph has nodes; verify color-by-health,
// legend, node→workspace navigation. Build the knowledge graph (npx gitnexus
// analyze) and record exactly what the user sees (spinner / stale / error chip).
// Test zoom/pan/fit/search-dimming + node inspector. Budget: ONE real dispatch.
// ===========================================================================

const CHARTER =
  'Knowledge Graph: Fleet Graph + Home graph + project Knowledge Graph tab. Assert ForceGraph canvas RENDERS (no AFRAME blank screen), color-by-health/legend/node-nav, graph build (gitnexus analyze), zoom/pan/fit/search, node inspector, ONE node-scoped dispatch.'
const findings: Finding[] = []
let sink: ConsoleSink

// Cross-test state: a registered fixture project id, captured once.
let projectId: string | null = null
let graphRendered = false
let graphBuildOutcome = 'not attempted'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

/** A ForceGraph2D mount produces exactly one <canvas>. This is the render proof. */
async function canvasIsLive(page: Page, root = page.locator('body')): Promise<boolean> {
  const canvas = root.locator('canvas').first()
  try {
    await expect(canvas).toBeVisible({ timeout: 10_000 })
  } catch {
    return false
  }
  // Non-zero drawing surface => the renderer actually laid out (not a 0x0 stub).
  const box = await canvas.boundingBox().catch(() => null)
  return !!box && box.width > 0 && box.height > 0
}

/** Register a local fixture repo through the real Register modal. Returns the
 *  project id parsed from the URL after clicking a project card, or null. */
async function registerFixture(page: Page, name: string): Promise<string | null> {
  const repoPath = makeScratchRepo('P06', name)
  await gotoApp(page, '#/projects')
  // Open the modal: the header trigger is "+ register project".
  await page.getByRole('button', { name: '+ register project' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  // Name + source inputs (placeholder-based; selectors are unstable by design).
  await dialog.getByPlaceholder(/name/i).fill(name)
  await dialog.getByPlaceholder(/path.*repo|github/i).fill(repoPath)
  // The modal submit button is exactly "Register →".
  await dialog.getByRole('button', { name: 'Register →' }).click()
  // Modal closes on success; the card should appear.
  await expect(dialog).toBeHidden({ timeout: 8_000 }).catch(() => {})
  await page.waitForTimeout(800)
  // Resolve the id from the app's own API (robust): the project card is a
  // role=button with a NESTED "Run verification" button, which makes the
  // accessible-name hit-test for a card click unreliable. The list endpoint is
  // authoritative. (Done in-page so the Vite proxy injects the auth token.)
  const id = await page
    .evaluate(async (n: string) => {
      const res = await fetch('/api/projects')
      if (!res.ok) return null
      const list = (await res.json()) as Array<{ id: string; name: string }>
      return list.find(p => p.name === n)?.id ?? null
    }, name)
    .catch(() => null)
  return id
}

test('register fixtures so the fleet graph has nodes', async ({ page }) => {
  let id: string | null = null
  try {
    id = await registerFixture(page, 'graph-a')
    // A second fixture so the fleet has >1 node (force layout, multiple colours).
    await registerFixture(page, 'graph-b').catch(() => {})
  } catch (e) {
    findings.push({
      title: 'Registering a fixture project through the Register modal failed',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects / Register modal',
      repro: 'Projects → + register project → fill name + local path → Register.',
      expected: 'Project registers and appears as a card; modal closes.',
      actual: `Registration threw: ${e instanceof Error ? e.message : String(e)}`,
      evidence: 'registerFixture() helper',
    })
  }
  projectId = id
  await screenshot(page, 'P06-projects-after-register')
  if (!id) {
    findings.push({
      title: 'Could not resolve a project id after registration',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects',
      repro: 'Register a local fixture; click the new card; read #/project/<id>.',
      expected: 'Clicking the card routes to #/project/<id>/overview.',
      actual: 'No project card was clickable / no #/project/<id> in the URL.',
      evidence: 'reports/screens/P06-projects-after-register.png',
    })
  }
})

test('Home fleet graph renders a live ForceGraph canvas (AFRAME footgun guard)', async ({ page }) => {
  await gotoApp(page, '#/home')
  // The Home fleet graph is a section titled "Fleet Graph" with an expand link.
  const section = page.getByText('Fleet Graph', { exact: false }).first()
  await expect(section).toBeVisible().catch(() => {})

  const live = await canvasIsLive(page)
  await screenshot(page, 'P06-home-graph')
  if (live) graphRendered = true
  else {
    findings.push({
      title: 'Home fleet graph canvas did not render',
      severity: 'High',
      category: 'Bug',
      surface: 'Home / HomeFleetGraph',
      repro: 'Register ≥1 project → open #/home → look at the Fleet Graph section.',
      expected: 'A visible, non-zero ForceGraph2D <canvas> with project nodes.',
      actual: 'No live canvas found (0×0 or absent). May indicate no projects or a render failure.',
      evidence: 'reports/screens/P06-home-graph.png',
    })
  }
})

test('Fleet Graph (#/graph) renders, shows the legend, and navigates on node click', async ({ page }) => {
  const { ms } = await timed(() => gotoApp(page, '#/graph'))
  await expect(page.getByRole('heading', { name: 'Fleet Graph' })).toBeVisible().catch(() => {})
  await screenshot(page, 'P06-fleet-graph')

  // CRITICAL render proof.
  const live = await canvasIsLive(page)
  if (live) {
    graphRendered = true
  } else {
    // Distinguish "no projects" empty-state from an actual render failure.
    const empty = await page
      .getByText(/No projects registered/i)
      .isVisible()
      .catch(() => false)
    findings.push({
      title: empty
        ? 'Fleet Graph empty (no projects) — could not verify canvas render'
        : 'Fleet Graph canvas did not render',
      severity: empty ? 'Low' : 'High',
      category: empty ? 'UX' : 'Bug',
      surface: 'Fleet Graph (#/graph)',
      repro: 'Register ≥1 project → open #/graph.',
      expected: 'A visible non-zero ForceGraph2D <canvas> + the 4-row health legend.',
      actual: empty ? 'Empty-state copy shown; no canvas to verify.' : 'No live canvas found.',
      evidence: 'reports/screens/P06-fleet-graph.png',
    })
  }

  // Legend: 4 health buckets (Healthy/At risk/Failing/Unverified).
  for (const label of [/Healthy/i, /At risk/i, /Failing/i, /Unverified/i]) {
    const ok = await page.getByText(label).first().isVisible().catch(() => false)
    if (!ok) {
      findings.push({
        title: `Fleet Graph legend missing a bucket (${label})`,
        severity: 'Low',
        category: 'UX',
        surface: 'Fleet Graph legend',
        repro: 'Open #/graph with ≥1 project and inspect the bottom-left legend.',
        expected: 'Legend lists Healthy / At risk / Failing / Unverified.',
        actual: `Legend entry matching ${label} was not visible.`,
        evidence: 'reports/screens/P06-fleet-graph.png',
      })
    }
  }

  // Click a node → expect navigation into a project workspace. Force-graph draws
  // nodes on a canvas with no DOM target, so click the canvas centre (the layout
  // settles a node near the origin/centre for a tiny fleet) and check the URL.
  if (live) {
    const canvas = page.locator('canvas').first()
    const box = await canvas.boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      const navigated = await page
        .waitForURL(/#\/project\//, { timeout: 4_000 })
        .then(() => true)
        .catch(() => false)
      if (navigated) {
        // Came back to a workspace; return to the graph for any later checks.
        await gotoApp(page, '#/graph')
      } else {
        // Canvas nodes have no DOM target, so a centre click only lands on a node
        // when the force layout happens to settle one there. This is a test-harness
        // limitation, not a confirmed app bug — record it as a low-severity coverage gap.
        findings.push({
          title: 'Could not confirm fleet-graph node→workspace navigation via canvas click',
          severity: 'Low',
          category: 'UX',
          surface: 'Fleet Graph node click',
          repro: 'Open #/graph, click the canvas centre.',
          expected: 'onNodeClick→navigate routes to #/project/<id> when a node is hit.',
          actual: 'URL stayed on #/graph (centre click likely missed a node — canvas-only hit-test, best-effort). Code wires onNodeClick→navigate(project,id); not refuted, just unverified by automation.',
          evidence: 'reports/screens/P06-fleet-graph.png; canvas centre click',
        })
      }
    }
  }

  if (ms > 5000) {
    findings.push({
      title: 'Fleet Graph navigation/render is slow',
      severity: 'Med',
      category: 'Perf',
      surface: 'Fleet Graph (#/graph)',
      repro: 'Navigate to #/graph and wait for WS + canvas.',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${ms}ms to reach WS-connected on #/graph.`,
      evidence: 'harness.timed()',
    })
  }
})

test('Knowledge Graph tab: build (gitnexus analyze), spinner/stale/error feedback', async ({ page }) => {
  if (!projectId) {
    findings.push({
      title: 'Skipped Knowledge Graph tab — no project id available',
      severity: 'Med',
      category: 'Missing',
      surface: 'Project Knowledge Graph tab',
      repro: 'Registration earlier failed to yield a project id.',
      expected: 'A registered project to open #/project/<id>/knowledge-graph.',
      actual: 'projectId was null; could not open the tab.',
      evidence: 'depends on registration test',
    })
    return
  }

  await gotoApp(page, `#/project/${projectId}/knowledge-graph`)
  await screenshot(page, 'P06-kg-initial')

  // Build/Refresh entry point. Initial label is "Build graph" when empty.
  const buildBtn = page
    .getByRole('button', { name: /Build graph|Rebuild|Refresh/i })
    .first()
  const hasBuild = await buildBtn.isVisible().catch(() => false)
  if (!hasBuild) {
    findings.push({
      title: 'No Build/Refresh control on the Knowledge Graph tab',
      severity: 'High',
      category: 'Missing',
      surface: 'Knowledge Graph tab toolbar',
      repro: 'Open #/project/<id>/knowledge-graph.',
      expected: 'A Build graph / Refresh / Rebuild button is visible.',
      actual: 'No build control found.',
      evidence: 'reports/screens/P06-kg-initial.png',
    })
    return
  }

  const { ms } = await timed(async () => {
    await buildBtn.click()
    // Look for the spinner / "Building…" feedback within a short window.
    const buildingSeen = await page
      .getByText(/Building…/)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (!buildingSeen) {
      findings.push({
        title: 'No visible "Building…" feedback after pressing Build',
        severity: 'Med',
        category: 'UX',
        surface: 'Knowledge Graph build',
        repro: 'KG tab → click Build graph.',
        expected: 'A spinner + "Building…" status appears while gitnexus analyze runs.',
        actual: 'No "Building…" indicator observed within 3s (build may have failed instantly or finished too fast).',
        evidence: 'reports/screens/P06-kg-building.png',
      })
    }
    await screenshot(page, 'P06-kg-building').catch(() => {})
    // Wait for the build to settle: either nodes appear, an error chip shows, or
    // the stale chip clears. Poll up to 35s (gitnexus analyze can be slow; this
    // env is resource-constrained, so don't hang the whole run on it).
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText
          return (
            /build failed/.test(t) ||
            /Graph build failed|Graph data unavailable/.test(t) ||
            !!document.querySelector('canvas')
          )
        },
        undefined,
        { timeout: 35_000 },
      )
      .catch(() => {})
  })

  await screenshot(page, 'P06-kg-after-build').catch(() => {})

  // Classify the outcome the USER sees. Guard every DOM read: a heavy gitnexus
  // build can OOM/crash the core server in this constrained env, which would
  // otherwise throw here instead of producing a finding.
  const bodyText = await page.locator('body').innerText().catch(() => '')
  const errorChip = await page.getByText('build failed', { exact: false }).isVisible().catch(() => false)
  const buildFailedMsg = /Graph build failed/.test(bodyText)
  const dataUnavailable = /Graph data unavailable/.test(bodyText)
  const kgCanvas = await canvasIsLive(page, page.locator('div').first())

  if (kgCanvas) {
    graphRendered = true
    graphBuildOutcome = `succeeded (${ms}ms) — canvas rendered`
  } else if (errorChip || buildFailedMsg) {
    // Capture the exact error text shown to the user.
    const errCode = await page.locator('code').first().innerText().catch(() => '')
    graphBuildOutcome = `failed (${ms}ms) — error chip shown`
    findings.push({
      title: 'Knowledge Graph build failed (gitnexus analyze)',
      severity: 'Med',
      category: 'Bug',
      surface: 'Knowledge Graph build',
      repro: 'KG tab on a freshly-registered local fixture → Build graph.',
      expected: 'gitnexus analyze produces a graph, or a clear, actionable error.',
      actual: `Build failed. User sees a red "build failed" chip${errCode ? ` and error: ${errCode.slice(0, 300)}` : ''}. This may be a legitimate env limitation (gitnexus not analyzable on a 1-file fixture).`,
      evidence: 'reports/screens/P06-kg-after-build.png',
    })
  } else if (dataUnavailable) {
    graphBuildOutcome = `data unavailable (${ms}ms)`
    findings.push({
      title: 'Knowledge Graph reports nodes but no renderable data ("Graph data unavailable")',
      severity: 'Med',
      category: 'Bug',
      surface: 'Knowledge Graph',
      repro: 'KG tab → Build graph → meta says ready+nodeCount>0 but graph.json missing.',
      expected: 'Built graphs render their nodes.',
      actual: 'Empty-state "Graph data unavailable — rebuild." shown.',
      evidence: 'reports/screens/P06-kg-after-build.png',
    })
  } else {
    graphBuildOutcome = `inconclusive (${ms}ms) — no canvas, no error chip`
    findings.push({
      title: 'Knowledge Graph build outcome inconclusive (no canvas, no error)',
      severity: 'Med',
      category: 'UX',
      surface: 'Knowledge Graph',
      repro: 'KG tab → Build graph → wait 60s.',
      expected: 'A terminal state: rendered graph OR a clear error/stale message.',
      actual: 'After 60s, neither a canvas nor an error/data-unavailable message was present.',
      evidence: 'reports/screens/P06-kg-after-build.png',
    })
  }

  if (ms > 30_000) {
    findings.push({
      title: 'Knowledge Graph build is very slow',
      severity: 'Low',
      category: 'Perf',
      surface: 'Knowledge Graph build',
      repro: 'KG tab → Build graph.',
      expected: 'A small fixture indexes quickly, or shows progress.',
      actual: `Build took ${ms}ms to reach a terminal state.`,
      evidence: 'harness.timed()',
    })
  }
})

test('Knowledge Graph interactions: fit/zoom/pan/search + node inspector + ONE dispatch', async ({ page }) => {
  if (!projectId) return
  await gotoApp(page, `#/project/${projectId}/knowledge-graph`)
  // Give a built graph a moment to lay out / hydrate from cache.
  await page.waitForTimeout(2_000)

  const canvas = page.locator('div').first().locator('canvas').first()
  const live = await canvas.isVisible().catch(() => false)
  if (!live) {
    // No rendered graph — interactions can't be tested. Already recorded the
    // build outcome above; note dispatch as unreachable and stop.
    findings.push({
      title: 'Node-scoped dispatch unreachable — no rendered knowledge graph',
      severity: 'Low',
      category: 'Missing',
      surface: 'Knowledge Graph dispatch',
      repro: 'KG tab with no built/renderable graph → no nodes to select.',
      expected: 'A node to click → inspector → Dispatch Agent confirm card.',
      actual: `No canvas to interact with. Build outcome: ${graphBuildOutcome}.`,
      evidence: 'reports/screens/P06-kg-after-build.png',
    })
    return
  }

  const box = await canvas.boundingBox()
  if (!box) return
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Fit ('f').
  try {
    await page.keyboard.press('f')
    await page.waitForTimeout(500)
  } catch { /* best-effort */ }

  // Zoom (scroll).
  try {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, 300)
  } catch { /* best-effort */ }

  // Pan (drag).
  try {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 80, cy + 40, { steps: 8 })
    await page.mouse.up()
  } catch { /* best-effort */ }

  // Search dimming: type into the filter and confirm the input reflects it.
  try {
    const filter = page.getByPlaceholder(/Filter nodes/i)
    await filter.fill('z')
    await page.waitForTimeout(400)
    await screenshot(page, 'P06-kg-search-dim')
    await filter.fill('')
  } catch {
    findings.push({
      title: 'Knowledge Graph filter input not usable',
      severity: 'Low',
      category: 'UX',
      surface: 'Knowledge Graph toolbar',
      repro: 'KG tab → type in "Filter nodes…".',
      expected: 'Typing filters/dims nodes.',
      actual: 'Filter input not found or not editable.',
      evidence: 'reports/screens/P06-kg-search-dim.png',
    })
  }

  // Open the node inspector by clicking a node (canvas-only hit-test; click centre).
  await page.mouse.click(cx, cy)
  const inspector = page.getByText('Node', { exact: true }).first()
  const inspectorOpen = await inspector.isVisible({ timeout: 3_000 }).catch(() => false)
  await screenshot(page, 'P06-kg-inspector')

  if (!inspectorOpen) {
    findings.push({
      title: 'Node inspector did not open on node click',
      severity: 'Low',
      category: 'UX',
      surface: 'Knowledge Graph node inspector',
      repro: 'KG tab → click a node on the canvas.',
      expected: 'A right-side inspector panel opens with the node label/type/file/ID.',
      actual: 'No inspector panel appeared after a centre-canvas click (hit-test is canvas-only; the node may not be centred).',
      evidence: 'reports/screens/P06-kg-inspector.png',
    })
    return
  }

  // ── ONE real dispatch (budget = exactly one). Stack is RUN_PERMISSION_MODE=plan. ──
  try {
    const dispatchOpen = page.getByRole('button', { name: /Dispatch Agent/i })
    await dispatchOpen.click()
    // Confirm card (role=dialog, title "Dispatch agent").
    const card = page.getByRole('dialog')
    await expect(card).toBeVisible({ timeout: 4_000 })
    await expect(card.getByText(/Dispatch agent/i)).toBeVisible()
    await screenshot(page, 'P06-kg-dispatch-card')

    // Fire it (Investigate is preselected; safe under plan mode).
    await card.getByRole('button', { name: /^Dispatch$/ }).click()
    // Either an "Agent dispatched." notice (+ View run) or an error notice.
    const ok = await page
      .getByText(/Agent dispatched/i)
      .isVisible({ timeout: 8_000 })
      .catch(() => false)
    const err = await page
      .getByText(/Dispatch failed|failed/i)
      .first()
      .isVisible()
      .catch(() => false)
    await screenshot(page, 'P06-kg-dispatch-result')
    if (ok) {
      // Confirm the run is reachable in Runs.
      const viewRun = page.getByRole('button', { name: /View run/i }).first()
      await viewRun.click().catch(() => {})
      await page.waitForURL(/#\/project\/.*\/runs/, { timeout: 4_000 }).catch(() => {})
      await screenshot(page, 'P06-kg-dispatch-run')
    } else {
      findings.push({
        title: 'Node-scoped dispatch did not confirm success',
        severity: 'Med',
        category: 'Bug',
        surface: 'Knowledge Graph dispatch',
        repro: 'KG tab → select node → Dispatch Agent → Investigate → Dispatch.',
        expected: 'An "Agent dispatched." notice with a View-run link, and a run appears.',
        actual: err
          ? 'A dispatch error notice was shown instead of success.'
          : 'Neither success nor error notice appeared within 8s.',
        evidence: 'reports/screens/P06-kg-dispatch-result.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Dispatch flow errored',
      severity: 'Med',
      category: 'Bug',
      surface: 'Knowledge Graph dispatch',
      repro: 'KG tab → select node → Dispatch Agent.',
      expected: 'A confirm card opens and dispatch succeeds (plan mode).',
      actual: `Dispatch flow threw: ${e instanceof Error ? e.message : String(e)}`,
      evidence: 'reports/screens/P06-kg-dispatch-card.png',
    })
  }
})

test.afterEach(async () => {
  // Fail-loud: a client-rendered SPA can crash at module-eval time (the AFRAME
  // footgun) with no failing assertion. Console/page errors are findings.
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error on a graph surface (possible AFRAME/render crash)',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Graph surfaces',
      repro: 'Drive Home/Fleet/Knowledge-Graph with the console attached.',
      expected: 'Zero uncaught page errors; ForceGraph2D mounts cleanly.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    // Filter out benign network noise (e.g. a 4xx the UI handles) vs real errors.
    const real = sink.errors.filter(
      e => !/Failed to load resource.*the server responded with a status of 40/.test(e),
    )
    if (real.length) {
      findings.push({
        title: 'console.error logged on a graph surface',
        severity: 'High',
        category: 'Bug',
        surface: 'Graph surfaces',
        repro: 'Drive the graph surfaces with the console attached.',
        expected: 'No console.error in a clean session (esp. no "AFRAME is not defined").',
        actual: real.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  // Leave a breadcrumb of the two headline outcomes regardless of findings.
  findings.push({
    title: `SUMMARY — graph rendered: ${graphRendered ? 'YES' : 'NO'} · KG build: ${graphBuildOutcome}`,
    severity: 'Nit',
    category: 'Docs-mismatch',
    surface: 'P06 run summary',
    repro: 'n/a',
    expected: 'Graph canvas renders (no AFRAME blank screen); build reaches a terminal state.',
    actual: `graphRendered=${graphRendered}; buildOutcome=${graphBuildOutcome}`,
    evidence: 'Aggregate of P06 run.',
  })
  writeFindings('P06', CHARTER, findings)
})

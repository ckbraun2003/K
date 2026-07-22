import { test, expect, type Page } from '@playwright/test'
import { gotoApp, captureConsole, type ConsoleSink } from '../lib/harness'
import fs from 'node:fs'
import path from 'node:path'

// ===========================================================================
// UI Simplification — the FULL route screenshot matrix + redirect smoke for
// the post-restructure 13-view IA (replaces p4-route-matrix.spec.ts, which
// exercised the retired 9-item rail: #/org, #/skills, #/runs/workflows,
// #/inbox as CANONICAL routes are now all legacy hashes that redirect into
// the 6-rail hubs — see web/src/lib/route.ts KNOWN_VIEWS/VIEW_REDIRECTS).
//
// Drives a REAL browser (the repo's hard-won lesson: unit tests do NOT catch
// module-eval blank screens — e.g. the AFRAME crash). Playwright's fullPage
// screenshots are the render-don't-read evidence a reviewer inspects.
//
// For every route it (a) captures a fullPage PNG, (b) records the
// canonicalized address-bar hash, (c) asserts #root is non-empty, (d) asserts
// a landmark testid/locator proving the RIGHT sub-view landed, and (e)
// collects console/page errors. Redirect rows additionally assert the hash
// canonicalized to the expected new-IA destination (VIEW_REDIRECTS, verbatim).
//
//   CORE_PORT=3221 WEB_PORT=4221 pnpm exec playwright test \
//     --config e2e/playwright.config.ts specs/ui-simpl-route-matrix.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })
test.skip(!!process.env.PERSONA, 'ui-simpl-route-matrix: run standalone, not in the persona swarm')

const OUT = path.resolve(__dirname, '..', 'reports', 'ui-simpl-matrix')
const SHOTS = path.resolve(OUT, 'shots')

interface RouteCheck {
  name: string
  hash: string
  /** expected canonical hash suffix after redirect (address bar); omit if it stays put */
  canonical?: string
  /** a locator that must be visible to prove the RIGHT sub-view landed */
  expectVisible?: (page: Page) => Promise<void>
  notFound?: boolean
}

const ROUTES: RouteCheck[] = [
  // ---- 6-item primary rail + hub default landings ----
  { name: '01-home', hash: '#/home', expectVisible: (p) => expect(p.getByTestId('seg-chat')).toHaveAttribute('aria-pressed', 'true') },
  { name: '02-personal-inbox', hash: '#/personal/inbox', expectVisible: (p) => expect(p.getByTestId('tab-inbox')).toHaveAttribute('aria-selected', 'true') },
  { name: '03-personal-tasks', hash: '#/personal/tasks', expectVisible: (p) => expect(p.getByTestId('tab-tasks')).toHaveAttribute('aria-selected', 'true') },
  { name: '04-personal-chats', hash: '#/personal/chats', expectVisible: (p) => expect(p.getByTestId('tab-chats')).toHaveAttribute('aria-selected', 'true') },
  { name: '05-personal-memories', hash: '#/personal/memories', expectVisible: (p) => expect(p.getByTestId('tab-memories')).toHaveAttribute('aria-selected', 'true') },
  { name: '06-agents-org-roster', hash: '#/agents/org/roster', expectVisible: async (p) => {
    await expect(p.getByTestId('tab-org')).toHaveAttribute('aria-selected', 'true')
    await expect(p.getByTestId('seg-roster')).toHaveAttribute('aria-pressed', 'true')
  } },
  { name: '07-agents-org-tree', hash: '#/agents/org/tree', expectVisible: (p) => expect(p.getByTestId('seg-tree')).toHaveAttribute('aria-pressed', 'true') },
  { name: '08-agents-org-graph', hash: '#/agents/org/graph', expectVisible: (p) => expect(p.getByTestId('seg-graph')).toHaveAttribute('aria-pressed', 'true') },
  { name: '09-agents-skills', hash: '#/agents/skills', expectVisible: (p) => expect(p.getByTestId('tab-skills')).toHaveAttribute('aria-selected', 'true') },
  { name: '10-agents-pipelines', hash: '#/agents/pipelines', expectVisible: (p) => expect(p.getByTestId('tab-pipelines')).toHaveAttribute('aria-selected', 'true') },
  { name: '11-runs', hash: '#/runs', expectVisible: (p) => expect(p.getByText(/Select a run/i)).toBeVisible() },
  { name: '12-insights-overview', hash: '#/insights/overview', expectVisible: (p) => expect(p.getByTestId('tab-overview')).toHaveAttribute('aria-selected', 'true') },
  { name: '13-insights-charts', hash: '#/insights/charts', expectVisible: (p) => expect(p.getByTestId('tab-charts')).toHaveAttribute('aria-selected', 'true') },
  { name: '14-insights-routing', hash: '#/insights/routing', expectVisible: (p) => expect(p.getByTestId('tab-routing')).toHaveAttribute('aria-selected', 'true') },
  { name: '15-insights-evals', hash: '#/insights/evals', expectVisible: (p) => expect(p.getByTestId('tab-evals')).toHaveAttribute('aria-selected', 'true') },
  { name: '16-projects', hash: '#/projects', expectVisible: (p) => expect(p.getByTestId('register-open')).toBeVisible() },
  // scoped to <main> — the TopBar's own topbar-title also reads "Settings" here
  // (it mirrors the active destination's label), so an unscoped role query is
  // a strict-mode ambiguity, not a real assertion of the page landmark.
  { name: '17-settings', hash: '#/settings', expectVisible: (p) => expect(p.locator('main').getByRole('heading', { name: 'Settings' })).toBeVisible() },
  { name: '18-docs-project-bible', hash: '#/docs/project-bible', expectVisible: (p) => expect(p.getByTestId('doc-edit-toggle')).toBeVisible() },
  // ---- hidden-but-routed drill-ins (still KNOWN_VIEWS, reached via deep-link) ----
  // scoped to <main> — TopBar's own <h1 data-testid="topbar-title"> also matches an
  // unscoped 'h1' locator (strict-mode ambiguity), same fix as the Settings row above.
  { name: '19-orchestrator-detail', hash: '#/orchestrator/lead-frontend', expectVisible: (p) => expect(p.locator('main h1')).toBeVisible() },
  { name: '20-timeline', hash: '#/timeline', expectVisible: (p) => expect(p.getByTestId('timeline-page')).toBeVisible() },
  { name: '21-skill-creator', hash: '#/skill-creator', expectVisible: (p) => expect(p.getByTestId('draft-new')).toBeVisible() },
  // ---- every legacy-hash redirect (asserts canonicalization — route.ts VIEW_REDIRECTS, verbatim) ----
  { name: '22-redirect-chief', hash: '#/chief', canonical: '#/agents/org/tree' },
  { name: '23-redirect-orchestrators', hash: '#/orchestrators', canonical: '#/agents/org/roster' },
  { name: '24-redirect-graph', hash: '#/graph', canonical: '#/agents/org/graph' },
  { name: '25-redirect-metrics', hash: '#/metrics', canonical: '#/insights/charts' },
  { name: '26-redirect-routing', hash: '#/routing', canonical: '#/insights/routing' },
  { name: '27-redirect-evals', hash: '#/evals', canonical: '#/insights/evals' },
  { name: '28-redirect-workflows', hash: '#/workflows', canonical: '#/agents/pipelines' },
  { name: '29-redirect-workflow-detail', hash: '#/workflow-detail/code-wave', canonical: '#/agents/pipelines/code-wave' },
  { name: '30-redirect-memory', hash: '#/memory', canonical: '#/personal/inbox' },
  { name: '32-redirect-org', hash: '#/org', canonical: '#/agents/org/roster' },
  { name: '33-redirect-skills', hash: '#/skills', canonical: '#/agents/skills' },
  { name: '34-redirect-inbox', hash: '#/inbox', canonical: '#/personal/inbox' },
  { name: '35-redirect-lessons', hash: '#/lessons', canonical: '#/personal/inbox' },
  // 'runs' has an identity-returning redirect (only its folded 'workflows' sub-view
  // moves — route.ts comment) — a DIFFERENT source hash from #28 landing on the SAME
  // canonical target proves that fold specifically, not just #/workflows's own redirect.
  { name: '36-redirect-runs-workflows', hash: '#/runs/workflows', canonical: '#/agents/pipelines' },
  // ---- 404 ----
  { name: '37-notfound', hash: '#/nonsense-xyz', notFound: true },
]

interface RouteResult {
  name: string
  hash: string
  finalHash: string
  canonicalOk: boolean | null
  rootNonEmpty: boolean
  errors: string[]
  pageErrors: string[]
}

const results: RouteResult[] = []

test('UI Simplification full route matrix — capture + redirect canonicalization', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const sink: ConsoleSink = captureConsole(page)

  for (const r of ROUTES) {
    // clear the per-route error slices so each row reports only its own
    sink.errors.length = 0
    sink.pageErrors.length = 0

    await gotoApp(page, r.hash)
    // let a redirect effect settle, async data (e.g. the Skills capability
    // catalog scan) resolve, then the sub-view paint — networkidle, with a
    // fixed floor so a persistent WS/poller can't starve the settle.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)

    const finalHash = '#' + (new URL(page.url()).hash.replace(/^#/, '') || '/')
    const rootNonEmpty = !(await page.locator('#root').evaluate((el) => el.childElementCount === 0))

    if (r.notFound) {
      // NotFound must render (a real page), not blank or crash.
      await expect(page.getByTestId('route-404')).toBeVisible({ timeout: 10_000 })
    } else if (r.expectVisible) {
      await r.expectVisible(page)
    }

    let canonicalOk: boolean | null = null
    if (r.canonical) {
      canonicalOk = finalHash === r.canonical
      expect(finalHash, `${r.hash} should canonicalize to ${r.canonical}`).toBe(r.canonical)
    }

    await page.screenshot({ path: path.join(SHOTS, `${r.name}.png`), fullPage: true })

    results.push({
      name: r.name,
      hash: r.hash,
      finalHash,
      canonicalOk,
      rootNonEmpty,
      errors: [...sink.errors],
      pageErrors: [...sink.pageErrors],
    })
    expect(rootNonEmpty, `${r.hash} rendered a non-empty #root`).toBe(true)
  }

  fs.writeFileSync(path.join(OUT, 'matrix-result.json'), JSON.stringify(results, null, 2), 'utf8')

  // No route may raise an uncaught page error (a module-eval / render crash).
  const crashed = results.filter((x) => x.pageErrors.length > 0)
  expect(crashed, `routes with uncaught page errors: ${crashed.map((c) => c.hash).join(', ')}`).toEqual([])
})

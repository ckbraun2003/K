import { test, expect, type Page } from '@playwright/test'
import { gotoApp, captureConsole, type ConsoleSink } from '../lib/harness'
import fs from 'node:fs'
import path from 'node:path'

// ===========================================================================
// P4 (IA Restructure) — the FULL route screenshot matrix + redirect smoke.
//
// Drives a REAL browser (the repo's hard-won lesson: unit tests do NOT catch
// module-eval blank screens — e.g. the AFRAME crash). Playwright's fullPage
// screenshots are the render-don't-read evidence an opus reviewer inspects.
//
// This is the MCP-down substitute for the Task-13 matrix + the Task-14 redirect
// smoke: for every route it (a) captures a fullPage PNG, (b) records the
// canonicalized address-bar hash, (c) asserts #root is non-empty, and (d)
// collects console/page errors. Redirect rows additionally assert the hash
// canonicalized to the expected P4 home.
//
//   CORE_PORT=3199 WEB_PORT=4199 pnpm exec playwright test \
//     --config e2e/playwright.config.ts specs/p4-route-matrix.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })
test.skip(!!process.env.PERSONA, 'p4-route-matrix: run standalone, not in the persona swarm')

const OUT = path.resolve(__dirname, '..', 'reports', 'p4-matrix')
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
  // ---- 9-item rail ----
  { name: '01-home', hash: '#/' },
  { name: '02-org', hash: '#/org', expectVisible: (p) => expect(p.getByTestId('seg-roster')).toHaveAttribute('aria-pressed', 'true') },
  { name: '03-projects', hash: '#/projects' },
  { name: '04-skills', hash: '#/skills' },
  { name: '05-runs', hash: '#/runs' },
  { name: '06-insights', hash: '#/insights' },
  { name: '07-inbox', hash: '#/inbox' },
  { name: '08-docs-bible', hash: '#/docs/project-bible' },
  { name: '09-settings', hash: '#/settings' },
  // ---- segment / tab deep-links ----
  { name: '10-org-tree', hash: '#/org/tree', expectVisible: (p) => expect(p.getByTestId('seg-tree')).toHaveAttribute('aria-pressed', 'true') },
  { name: '11-org-graph', hash: '#/org/graph', expectVisible: (p) => expect(p.getByTestId('seg-graph')).toHaveAttribute('aria-pressed', 'true') },
  { name: '12-insights-charts', hash: '#/insights/charts' },
  { name: '13-insights-routing', hash: '#/insights/routing' },
  { name: '14-insights-evals', hash: '#/insights/evals' },
  { name: '15-runs-workflows', hash: '#/runs/workflows', expectVisible: (p) => expect(p.getByTestId('seg-workflows')).toHaveAttribute('aria-pressed', 'true') },
  // ---- drill-ins ----
  { name: '16-orchestrator-detail', hash: '#/orchestrator/lead-frontend' },
  { name: '17-lessons', hash: '#/lessons' },
  { name: '18-timeline', hash: '#/timeline' },
  { name: '19-skill-creator', hash: '#/skill-creator' },
  // ---- every legacy-hash redirect (asserts canonicalization) ----
  { name: '20-redirect-chief', hash: '#/chief', canonical: '#/org/tree' },
  { name: '21-redirect-orchestrators', hash: '#/orchestrators', canonical: '#/org/roster' },
  { name: '22-redirect-graph', hash: '#/graph', canonical: '#/org/graph' },
  { name: '23-redirect-metrics', hash: '#/metrics', canonical: '#/insights/charts' },
  { name: '24-redirect-routing', hash: '#/routing', canonical: '#/insights/routing' },
  { name: '25-redirect-evals', hash: '#/evals', canonical: '#/insights/evals' },
  { name: '26-redirect-workflows', hash: '#/workflows', canonical: '#/runs/workflows' },
  { name: '27-redirect-workflow-detail', hash: '#/workflow-detail/code-wave', canonical: '#/runs/workflows/code-wave' },
  { name: '28-redirect-memory', hash: '#/memory', canonical: '#/inbox' },
  { name: '29-redirect-terminal', hash: '#/terminal', canonical: '#/settings' },
  // ---- 404 ----
  { name: '30-notfound', hash: '#/nonsense-xyz', notFound: true },
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

test('P4 full route matrix — capture + redirect canonicalization', async ({ page }) => {
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
      await expect(page.getByText(/not found|404/i).first()).toBeVisible({ timeout: 10_000 })
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

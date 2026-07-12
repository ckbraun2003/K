import { type Page, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const here = __dirname
const REPORTS = path.resolve(here, '..', 'reports')
const SCREENS = path.resolve(REPORTS, 'screens')

// --- Console / page-error capture ------------------------------------------
// The single hardest-won lesson in this repo (tasks/lessons.md): unit tests and
// builds do NOT catch module-eval-time browser crashes (e.g. the AFRAME blank
// screen). So every persona MUST drive a real browser and read the console.

export interface ConsoleSink {
  errors: string[]
  warnings: string[]
  pageErrors: string[]
}

/** Attach listeners that record console.error/warn and uncaught page errors. */
export function captureConsole(page: Page): ConsoleSink {
  const sink: ConsoleSink = { errors: [], warnings: [], pageErrors: [] }
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.errors.push(msg.text())
    else if (msg.type() === 'warning') sink.warnings.push(msg.text())
  })
  page.on('pageerror', (err) => sink.pageErrors.push(String(err?.stack ?? err)))
  return sink
}

// --- App readiness ----------------------------------------------------------

/** Navigate to a hash route and wait for the WS status dot to go green. */
export async function gotoApp(page: Page, hash = '#/home'): Promise<void> {
  await page.goto(`/${hash}`)
  await waitForWs(page)
}

/** The TopBar renders `title="core connected"` once the WS gateway is live. */
export async function waitForWs(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator('[title="core connected"]')).toBeVisible({ timeout })
}

// --- Message Dock (⌘K) -------------------------------------------------------
// UI Simplification retired the CommandBar palette (Task 18); the TopBar's
// `topbar-dock-launcher` button (and the ⌘K chord, equally) now call
// `focusDock()` (web/src/lib/dock-bus.ts): the bar variant (Home) is already
// mounted inline and just takes focus, the float variant (elsewhere) opens
// its overlay first. Kept the export name so existing callers across the
// persona specs don't need touching for the "open it" step.

/** Open (or focus) the Message Dock composer via the TopBar button (keyboard chord is flaky in CI). */
export async function openCommandBar(page: Page): Promise<void> {
  await page.getByTestId('topbar-dock-launcher').click()
  await expect(page.getByTestId('dock-input')).toBeVisible()
}

// --- Timing -----------------------------------------------------------------

/** Run `fn`, return its elapsed ms. Personas flag anything slow with no feedback. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now()
  const value = await fn()
  return { ms: Date.now() - t0, value }
}

// --- Screenshots ------------------------------------------------------------

export async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SCREENS, { recursive: true })
  const file = path.join(SCREENS, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return path.relative(REPORTS, file)
}

// --- Findings report --------------------------------------------------------

export type Severity = 'Critical' | 'High' | 'Med' | 'Low' | 'Nit'
export type Category = 'Bug' | 'Perf' | 'UX' | 'Missing' | 'Docs-mismatch'

export interface Finding {
  title: string
  severity: Severity
  category: Category
  surface: string
  repro: string
  expected: string
  actual: string
  /** Screenshot path, console excerpt, network status, timing — whatever proves it. */
  evidence: string
}

const SEV_ORDER: Record<Severity, number> = { Critical: 0, High: 1, Med: 2, Low: 3, Nit: 4 }

/** Emit a persona's findings as `reports/<persona>.md` in the standard schema. */
export function writeFindings(persona: string, charter: string, findings: Finding[]): string {
  fs.mkdirSync(REPORTS, { recursive: true })
  const sorted = [...findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  const counts = sorted.reduce<Record<string, number>>((m, f) => {
    m[f.severity] = (m[f.severity] ?? 0) + 1
    return m
  }, {})
  const summary = (['Critical', 'High', 'Med', 'Low', 'Nit'] as Severity[])
    .map((s) => `${s}: ${counts[s] ?? 0}`)
    .join(' · ')

  const body = sorted
    .map(
      (f, i) => `### ${i + 1}. ${f.title}
- **Severity:** ${f.severity} · **Category:** ${f.category} · **Surface:** ${f.surface}
- **Repro:** ${f.repro}
- **Expected:** ${f.expected}
- **Actual:** ${f.actual}
- **Evidence:** ${f.evidence}`,
    )
    .join('\n\n')

  const md = `# ${persona} — User-Testing Findings

**Charter:** ${charter}

**Totals:** ${sorted.length} finding(s) — ${summary}

_Generated ${new Date().toISOString()}_

---

${body || '_No findings recorded._'}
`
  const file = path.join(REPORTS, `${persona}.md`)
  fs.writeFileSync(file, md, 'utf8')
  return file
}

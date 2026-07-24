import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { captureConsole, gotoApp, screenshot, waitForWs, writeFindings, type ConsoleSink, type Finding } from '../lib/harness'

// ===========================================================================
// UI Adjustments ROUND 4 (D-135) live smoke. Drives a real browser against the
// auto-booted, isolated stack to prove the Round 4 changes render/behave as
// specified. Six checks, each hard-asserted (deterministic computed-style/DOM
// assertions) except #6 (Inbox), which is resilient per RUNBOOK.md since it
// depends on a direct DB-seeding technique that may not be portable:
//   1. Solid background color applies LIVE: switching to the Solid segment and
//      picking a custom hex must repaint `app-background` (data-variant=
//      solid) to that exact color — asserted via a real computed
//      `background-color`, not just the DOM attribute flip.
//   2. Primary + Secondary accent recolor LIVE: setting the Primary/Secondary
//      color pickers must write `--primary`/`--secondary` on the document
//      root, `--accent` (== var(--primary), no color-mix) must resolve to the
//      new primary hex (probed via a real consuming CSS property, since a
//      custom property's OWN computed value can return unresolved var() text
//      per spec), and an interaction surface driven by `--glass-active`
//      (color-mix(in srgb, var(--secondary) 30%, transparent) — the Settings
//      nav's default-active item) must resolve to the new secondary hue.
//   3. The Settings side-nav is a genuinely CONTAINED sidebar panel at
//      desktop width (>=1440x900): no longer `self-start` (floats to its
//      intrinsic height), now caps at `max-h-[calc(100vh-2rem)]` with
//      `overflow-y-auto`, and its buttons are the larger `text-body` size
//      (not the old `text-caption`) — mirrors web/test/settings-nav.test.tsx.
//   4. Base body font-weight is 450 (mirrors web/test/base-font-weight.test.ts,
//      which regexes index.css directly — this proves the LIVE computed
//      style actually reflects it, not just the source file).
//   5. New chat on load: leaving a thread open (`#/messages/<id>`) and
//      reloading the app must land on a bare `#/messages` (boot-hash.ts's
//      normalizeBootHash strips the id BEFORE React mounts, main.tsx) with
//      the generic "new chat" composer state — NOT resuming the
//      previously-open thread. The thread is created via a free
//      `POST /api/k/threads` call (no agent dispatch, no cost) — never a
//      real `ask.send()`.
//   6. Personal Inbox surfaces `input_needed` cards ONLY for a run with an
//      actual `input_request` event, never for a plain `awaiting_input` park
//      with no ask — seeded directly via a better-sqlite3 connection into the
//      isolated persona DB (core/test/inbox-routes.test.ts covers the same
//      derivation logic at the unit level; this proves it end-to-end through
//      the live route + rendered card). Falls back to a render-only check
//      (with a Low finding, not a faked pass) if DB seeding is impractical.
//
// Run standalone (own isolated port pair, NOT the shared 3001/5173 defaults):
//   CORE_PORT=3114 WEB_PORT=4114 PERSONA=UIADJ4 pnpm exec playwright test \
//     --config e2e/playwright.config.ts specs/ui-adjustments-r4-smoke.spec.ts \
//     --reporter=list --trace off
// ===========================================================================

test.describe.configure({ mode: 'serial' })

const PERSONA = 'UIADJ4'
const CHARTER =
  'UI Adjustments Round 4 (D-135) live smoke: live solid-background recolor, live primary/secondary ' +
  'accent recolor (--accent tracks primary, --glass-active tracks secondary), the Settings side-nav as ' +
  'a genuinely contained/scrollable sidebar panel with larger buttons, base body font-weight 450, ' +
  '"new chat on load" (a reload never resumes the previously-open thread — boot-hash.ts), and Personal ' +
  'Inbox input_needed cards gated on an actual input_request event (not a plain awaiting_input park).'

const findings: Finding[] = []
let sink: ConsoleSink

// Distinctive, deliberately-not-default hex values so a screenshot is
// unambiguous and computed-style assertions can't accidentally match a
// pre-existing default token.
const SOLID_HEX = '#2f9e8f' // -> rgb(47, 158, 143)
const PRIMARY_HEX = '#ff6600' // -> rgb(255, 102, 0) — default primary is #e294e0 (pink-violet)
const SECONDARY_HEX = '#22cc44' // -> rgb(34, 204, 68) — default secondary is #87cefa (sky-blue)

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

// --- Color helpers -------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace('#', ''), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** Playwright's `toHaveCSS` color-matching normalizes formats internally, so a
 *  plain `rgb(r, g, b)` string compares correctly against whatever the
 *  browser actually serializes. */
function rgbString(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgb(${r}, ${g}, ${b})`
}

/** Parses BOTH legacy `rgb[a](r, g, b[, a])` (0-255 ints) AND the CSS Color 4
 *  `color(srgb r g b / a)` form (0-1 floats) — this Chromium build serializes
 *  a `color-mix()` result (e.g. `--glass-active`) via the latter, not the
 *  former, so both must be handled to read a real computed color regardless
 *  of which token produced it. */
function parseRgb(css: string): { r: number; g: number; b: number; a: number } {
  const legacy = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (legacy) {
    return { r: Number(legacy[1]), g: Number(legacy[2]), b: Number(legacy[3]), a: legacy[4] !== undefined ? Number(legacy[4]) : 1 }
  }
  const colorFn = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
  if (colorFn) {
    return {
      r: Math.round(Number(colorFn[1]) * 255),
      g: Math.round(Number(colorFn[2]) * 255),
      b: Math.round(Number(colorFn[3]) * 255),
      a: colorFn[4] !== undefined ? Number(colorFn[4]) : 1,
    }
  }
  throw new Error(`Could not parse a computed color: "${css}"`)
}

/** Native `<input type=color>` elements can't be driven via a real OS picker
 *  headlessly, and Playwright's `fill()` support for type=color is unreliable
 *  across versions — so set `.value` via the NATIVE prototype setter (bypassing
 *  React's instance-level tracked-value wrapper) then dispatch real `input` +
 *  `change` events. React compares the DOM's current value against its last
 *  tracked value on the next `input` event, sees the mismatch, and fires
 *  `onChange` for real — the standard headless-testing technique for
 *  React-controlled inputs. */
async function setColorInput(page: Page, testId: string, hex: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).evaluate((el, value: string) => {
    const input = el as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) nativeSetter.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, hex)
}

// --- 1. Solid background color applies live -------------------------------------

test('1. Solid background color applies live (app-background computed to the chosen hex)', async ({ page }) => {
  await openApp(page, '#/settings')
  const section = page.getByTestId('appearance-section')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('seg-solid').click()
  await setColorInput(page, 'background-solid-color', SOLID_HEX)

  const bg = page.locator('[data-testid="app-background"]')
  await expect(bg).toHaveAttribute('data-variant', 'solid', { timeout: 10_000 })
  await expect(bg).toHaveCSS('background-color', rgbString(SOLID_HEX), { timeout: 10_000 })

  await screenshot(page, 'r4-1-settings-solid-color')
  await openApp(page, '#/home')
  await screenshot(page, 'r4-1-home-solid-color')

  recordConsoleFindings('#/settings + #/home (solid background color)')
})

// --- 2. Primary + Secondary accent recolor live ---------------------------------

test('2. Primary + Secondary accent colors recolor live (--accent tracks primary, --glass-active tracks secondary)', async ({ page }) => {
  await openApp(page, '#/settings')
  const section = page.getByTestId('appearance-section')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toBeVisible({ timeout: 10_000 })

  await setColorInput(page, 'primary-color-input', PRIMARY_HEX)
  await setColorInput(page, 'secondary-color-input', SECONDARY_HEX)

  // --primary/--secondary are set as LITERAL strings (no var() indirection),
  // so reading them straight off the inline style is unambiguous — unlike
  // --accent below, there's no computed-value substitution question here.
  await expect.poll(
    () => page.evaluate(() => document.documentElement.style.getPropertyValue('--primary').trim()),
    { timeout: 10_000, message: '--primary should be written to the document root' },
  ).toBe(PRIMARY_HEX)
  await expect.poll(
    () => page.evaluate(() => document.documentElement.style.getPropertyValue('--secondary').trim()),
    { timeout: 10_000, message: '--secondary should be written to the document root' },
  ).toBe(SECONDARY_HEX)

  // --accent (index.css: `--accent: var(--primary);`) — probe via a REAL
  // consuming property (a custom property's own computed value can return
  // unresolved var() token text per spec; a real property must resolve to
  // paint at all, so this is unambiguous across engines).
  const accentRgb = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.color = 'var(--accent)'
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    return rgb
  })
  const accentParsed = parseRgb(accentRgb)
  const primaryRgb = hexToRgb(PRIMARY_HEX)
  expect(accentParsed.r, `--accent should track primary's red channel (got ${accentRgb})`).toBe(primaryRgb.r)
  expect(accentParsed.g, `--accent should track primary's green channel (got ${accentRgb})`).toBe(primaryRgb.g)
  expect(accentParsed.b, `--accent should track primary's blue channel (got ${accentRgb})`).toBe(primaryRgb.b)

  // The Settings nav's first (default-active, SettingsNav.tsx useState(items[0]))
  // item is styled `bg-[var(--glass-active)]` — index.css: `--glass-active:
  // color-mix(in srgb, var(--secondary) 30%, transparent)`. color-mix against
  // "transparent" preserves the source RGB channels exactly and scales alpha
  // to the mix ratio, so this is an exact, computable assertion of a REAL
  // rendered interaction surface (not a synthetic probe). The button also
  // carries `transition-colors` (Tailwind), so the FIRST read after the
  // custom property changes can land mid-transition (the browser then
  // serializes an interpolated frame in `oklab(...)`, not `color(srgb ...)`)
  // — poll until the read is both parseable AND in-tolerance, so a transient
  // mid-animation frame retries instead of hard-failing.
  const secondaryRgb = hexToRgb(SECONDARY_HEX)
  let activeNavBg = ''
  await expect.poll(
    async () => {
      activeNavBg = await page.locator('nav[aria-label="Settings sections"] button[aria-current="true"]')
        .first().evaluate(el => getComputedStyle(el).backgroundColor)
      try {
        const p = parseRgb(activeNavBg)
        return p.r === secondaryRgb.r && p.g === secondaryRgb.g && p.b === secondaryRgb.b && p.a > 0.2 && p.a < 0.4
      } catch {
        return false // mid-transition (e.g. a transient oklab(...) frame) — retry
      }
    },
    { timeout: 10_000, message: 'active nav item background should settle on --glass-active tracking the new secondary color' },
  ).toBe(true)

  const screensDir = path.resolve(__dirname, '..', 'reports', 'screens')
  fs.mkdirSync(screensDir, { recursive: true })
  await screenshot(page, 'r4-2-settings-recolor')
  try {
    await page.locator('nav[aria-label="Settings sections"]').screenshot({ path: path.join(screensDir, 'r4-2-settings-nav-active.png') })
  } catch {
    // best effort crop; the full-page shot above already covers it
  }

  // Messages' default (no-selection) hero renders an EmptyState with
  // tier="solid" (MessagesPage.tsx) — its icon chip is the `.glass-icon`
  // class (`background: var(--glass-icon)`, itself `color-mix(in srgb,
  // var(--primary) 20%, transparent)`), the clearest real "glass icon"
  // surface to eyeball the primary recolor on.
  await openApp(page, '#/messages')
  await screenshot(page, 'r4-2-messages-glass-icon')

  recordConsoleFindings('#/settings + #/messages (primary/secondary recolor)')
})

// --- 3. Settings nav: contained sidebar panel -----------------------------------

test('3. Settings side-nav renders as a contained, scrollable sidebar panel (>=1440x900)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openApp(page, '#/settings')

  const nav = page.locator('nav[aria-label="Settings sections"]')
  await expect(nav).toBeVisible({ timeout: 10_000 })

  const navClass = await nav.evaluate(el => el.className)
  expect(navClass, 'nav must NOT use self-start (no longer floats to its intrinsic height)').not.toMatch(/\bself-start\b/)
  expect(navClass, 'nav must cap its height').toContain('max-h-[calc(100vh-2rem)]')
  expect(navClass, 'nav must scroll internally').toMatch(/\boverflow-y-auto\b/)
  expect(navClass, 'nav must stay sticky').toMatch(/\bsticky\b/)

  const buttonClass = await nav.locator('button').first().evaluate(el => el.className)
  expect(buttonClass, 'nav buttons must use the larger text-body size').toMatch(/\btext-body\b/)
  expect(buttonClass, 'nav buttons must NOT still use the old text-caption size').not.toMatch(/\btext-caption\b/)

  const computed = await nav.evaluate(el => {
    const s = getComputedStyle(el)
    return { overflowY: s.overflowY, bg: s.backgroundColor, borderWidth: s.borderWidth, borderStyle: s.borderStyle }
  })
  expect(computed.overflowY, 'computed overflow-y must be auto').toBe('auto')
  const isTransparent = computed.bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(computed.bg)
  expect(isTransparent, `nav background must be a non-transparent glass panel, got ${computed.bg}`).toBe(false)
  expect(
    computed.borderWidth === '0px' && computed.borderStyle === 'none',
    'nav must have a visible hairline border (glass panel container)',
  ).toBe(false)

  const screensDir = path.resolve(__dirname, '..', 'reports', 'screens')
  fs.mkdirSync(screensDir, { recursive: true })
  try {
    await nav.screenshot({ path: path.join(screensDir, 'r4-3-settings-nav.png') })
  } catch {
    await page.screenshot({ path: path.join(screensDir, 'r4-3-settings-nav.png'), fullPage: true })
  }
  await screenshot(page, 'r4-3-settings-page')

  recordConsoleFindings('#/settings (nav contained panel, 1440x900)')
})

// --- 4. Base body font-weight 450 ------------------------------------------------

test('4. Base body font-weight is 450', async ({ page }) => {
  await openApp(page, '#/home')
  const fontWeight = await page.evaluate(() => getComputedStyle(document.body).fontWeight)
  expect(fontWeight, 'document.body computed font-weight must be 450').toBe('450')
  recordConsoleFindings('#/home (base font-weight)')
})

// --- 5. New chat on load (boot-hash.ts regression) --------------------------------

test('5. New chat on load: reload lands on a fresh #/messages composer, not the previously open thread', async ({ page }) => {
  await openApp(page, '#/home')

  // A free thread create — NO agent dispatch/cost (POST /api/k/threads just
  // inserts an empty row; askK backfills a title on the first real message).
  const threadId = await page.evaluate(async () => {
    const res = await fetch('/api/k/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) throw new Error(`POST /api/k/threads -> ${res.status}`)
    const thread = (await res.json()) as { id: string }
    return thread.id
  })
  expect(threadId, 'POST /api/k/threads should return a created thread id').toBeTruthy()

  // Simulate "left the app with a thread open": hash-navigate straight to it.
  await page.evaluate((id: string) => { location.hash = `#/messages/${id}` }, threadId)
  await expect(page).toHaveURL(new RegExp(`#/messages/${threadId}$`), { timeout: 10_000 })

  // The actual regression scenario: a REAL reload (full document reload —
  // main.tsx's pre-render normalizeBootHash runs on this document load).
  await page.reload()
  await waitForWs(page)
  await dismissHelp(page)

  await expect(page, 'a reload must strip the thread id from the boot hash (boot-hash.ts normalizeBootHash)')
    .toHaveURL(/#\/messages$/, { timeout: 10_000 })
  await expect(
    page.getByTestId('conversation-view'),
    'a reload must NOT resume the previously-open thread\'s ConversationView',
  ).toHaveCount(0)
  await expect(
    page.getByText('All your conversations in one place'),
    'a reload must land on the generic new-chat/no-selection hero',
  ).toBeVisible({ timeout: 10_000 })

  await screenshot(page, 'r4-5-reload-new-chat')
  recordConsoleFindings('#/messages (reload -> new chat)')
})

// --- 6. Personal Inbox: input_needed gated on an actual input_request event -------

/** Open a direct better-sqlite3 connection to THIS persona's isolated core DB.
 *  e2e/ is not its own pnpm workspace package, so `better-sqlite3` can't be
 *  resolved from here via normal node_modules lookup — resolve it explicitly
 *  from core/'s own node_modules (verified working: it's the same native
 *  module the running core server has open on this same DB file, in WAL
 *  mode, so a second short-lived connection for a quick insert/delete is
 *  safe with a modest busy_timeout). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
function openInboxDb(): any {
  const Database = require(path.resolve(__dirname, '..', '..', 'core', 'node_modules', 'better-sqlite3'))
  const corePort = process.env.CORE_PORT ?? '3001'
  const dbPath = path.resolve(__dirname, '..', '.data', `core-${corePort}`, 'k.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

interface SeededInbox { askRunId: string; plainRunId: string; question: string }

/** Seed two `awaiting_input` runs: one with a matching `input_request` event
 *  (must produce an input_needed card carrying the question text) and one
 *  bare park with no ask at all (must NOT produce a card) — the exact
 *  distinction core/test/inbox-routes.test.ts covers at the unit level. */
function seedInboxFixture(): SeededInbox {
  const db = openInboxDb()
  try {
    const now = Date.now()
    const askRunId = `uiadj4-ask-${now}`
    const plainRunId = `uiadj4-plain-${now}`
    const question = `UIADJ4 seeded question ${now}: Use Postgres or SQLite?`

    const insertRun = db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, ?, 'awaiting_input', ?)`,
    )
    insertRun.run(askRunId, 'UIADJ4 fixture: run WITH an input_request event', 'C:\\uiadj4-fixture', now)
    insertRun.run(plainRunId, 'UIADJ4 fixture: plain awaiting_input park, no ask', 'C:\\uiadj4-fixture', now + 1)

    db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, raw, text) VALUES (?, ?, 0, 'input_request', ?, ?, ?)`,
    ).run(`uiadj4-evt-${now}`, askRunId, now + 500, JSON.stringify({ kind: 'question' }), question)

    return { askRunId, plainRunId, question }
  } finally {
    db.close()
  }
}

function cleanupInboxFixture(seeded: SeededInbox): void {
  const db = openInboxDb()
  try {
    db.prepare(`DELETE FROM events WHERE run_id IN (?, ?)`).run(seeded.askRunId, seeded.plainRunId)
    db.prepare(`DELETE FROM runs WHERE id IN (?, ?)`).run(seeded.askRunId, seeded.plainRunId)
  } finally {
    db.close()
  }
}

test('6. Personal Inbox: input_needed cards appear ONLY for runs with an explicit input_request event', async ({ page }) => {
  let seeded: SeededInbox | null = null
  try {
    seeded = seedInboxFixture()
  } catch (err) {
    findings.push({
      title: 'Could not seed the Inbox DB fixture directly — falling back to a render-only check',
      severity: 'Low',
      category: 'Docs-mismatch',
      surface: '#/personal/inbox',
      repro: 'Open a direct better-sqlite3 connection to the isolated persona DB and insert runs/events rows.',
      expected:
        'n/a — informational only. The input_needed derivation (latest question wins per run, cleared after ' +
        'a later running status event) is covered at the unit level by core/test/inbox-routes.test.ts.',
      actual: String(err).slice(0, 300),
      evidence: 'n/a',
    })
  }

  await openApp(page, '#/personal/inbox')

  try {
    await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 10_000 })
  } catch (err) {
    findings.push({
      title: 'Personal Inbox page did not render',
      severity: 'Critical',
      category: 'Bug',
      surface: '#/personal/inbox',
      repro: "openApp(page, '#/personal/inbox')",
      expected: 'inbox-page testid visible.',
      actual: String(err).slice(0, 300),
      evidence: 'r4-6-inbox-render-only.png',
    })
  }

  if (seeded) {
    try {
      const askCard = page.getByTestId(`inbox-card-input_needed:${seeded.askRunId}`)
      await expect(askCard, 'the seeded run WITH an input_request event should show an input_needed card').toBeVisible({ timeout: 10_000 })
      await expect(askCard, 'the card should carry the literal question text').toContainText(seeded.question)

      const plainCard = page.getByTestId(`inbox-card-input_needed:${seeded.plainRunId}`)
      await expect(plainCard, 'the plain awaiting_input park (no ask) should NOT produce a card').toHaveCount(0)

      await screenshot(page, 'r4-6-inbox-input-needed')
    } catch (err) {
      findings.push({
        title: 'Personal Inbox input_needed derivation did not match the seeded fixture',
        severity: 'High',
        category: 'Bug',
        surface: '#/personal/inbox',
        repro: `Seed one awaiting_input run WITH an input_request event (question: "${seeded.question}") ` +
          'and one plain awaiting_input park with no events; load Personal Inbox.',
        expected: 'A card for the WITH-ask run carrying its question text; no card for the plain park.',
        actual: String(err).slice(0, 300),
        evidence: 'r4-6-inbox-input-needed.png',
      })
    } finally {
      try {
        cleanupInboxFixture(seeded)
      } catch { /* best effort cleanup */ }
    }
  } else {
    await screenshot(page, 'r4-6-inbox-render-only')
  }

  recordConsoleFindings('#/personal/inbox')
})

test.afterAll(() => {
  const file = writeFindings(PERSONA, CHARTER, findings)
  console.log(`[${PERSONA}] wrote ${findings.length} finding(s) to ${file}`)
})

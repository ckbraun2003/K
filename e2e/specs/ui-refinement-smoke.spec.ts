import { test, expect, type Page } from '@playwright/test'
import { captureConsole, gotoApp, screenshot, type ConsoleSink } from '../lib/harness'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// ===========================================================================
// UI-refinement visual smoke. Drives a REAL browser to prove the four
// refinement lanes actually render & behave — the lessons file is emphatic
// that unit/build tests cannot catch module-eval blank screens, the real
// react-query mutation→invalidate→re-render path, or a hash-router hijack.
//
// Covers:
//   A. the pipeline DAG now renders inside the *definition* inspector (was
//      text-only; the React Flow graph previously only showed for a run);
//   B. the background is a user-settable wallpaper (solid / gradient preset /
//      uploaded image) — no animated ambient/galaxy scene;
//   D. the Settings sidebar scrolls to a section WITHOUT writing location.hash
//      (an <a href="#id"> would hijack the hash router → navigate to a 404).
// (Lane C — modern-frosted glass — is a token retune with no new behavior; it
//  shows up in every screenshot as the panel chrome over the wallpaper.)
//
// Run standalone: pnpm exec playwright test --config e2e/playwright.config.ts \
//   e2e/specs/ui-refinement-smoke.spec.ts --reporter=list
// ===========================================================================

test.describe.configure({ mode: 'serial' })
test.skip(!!process.env.PERSONA, 'ui-refinement-smoke: run standalone, not in the persona swarm')

let sink: ConsoleSink
test.beforeEach(({ page }) => { sink = captureConsole(page) })

/** The 7-page help guide auto-opens on a first-run stack and its overlay
 *  intercepts pointer events — dismiss it before interacting. Once closed it
 *  stays closed for the page's lifetime (auto-open is a mount-only effect). */
async function dismissHelp(page: Page): Promise<void> {
  const guide = page.getByTestId('help-guide')
  await guide.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { /* not auto-opened */ })
  if (await guide.isVisible()) {
    await page.getByRole('button', { name: 'Close guide' }).click()
    await guide.waitFor({ state: 'hidden', timeout: 5000 })
  }
}

/** gotoApp (nav + WS-green) then dismiss the first-run help overlay. */
async function openApp(page: Page, hash: string): Promise<void> {
  await gotoApp(page, hash)
  await dismissHelp(page)
}

// --- Build a real PNG on disk so the image-upload path validates ------------
// The backend sniffs the decoded bytes (png/jpeg/webp only), so a hand-rolled
// base64 blob risks a false 400. Emit a genuine RGB PNG via zlib + a proper
// CRC32 per chunk — deterministic and guaranteed valid.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}
function makePng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  const row = Buffer.alloc(1 + w * 3) // leading filter byte (0) per scanline
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r
    row[1 + x * 3 + 1] = g
    row[1 + x * 3 + 2] = b
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

let pngPath: string
test.beforeAll(() => {
  pngPath = path.join(os.tmpdir(), `k-ui-refinement-wallpaper-${process.pid}.png`)
  fs.writeFileSync(pngPath, makePng(64, 64, [217, 70, 239])) // solid magenta — unmistakable vs gradient/solid
})
test.afterAll(() => {
  try { fs.rmSync(pngPath, { force: true }) } catch { /* best effort */ }
})

test('A. pipeline DAG renders inside the definition inspector (not just a run)', async ({ page }) => {
  await openApp(page, '#/agents/automations')
  await expect(page.getByTestId('pipeline-def-list')).toBeVisible({ timeout: 15_000 })

  // Open the first definition that carries an executable spec (others are disabled).
  const inspect = page.locator('[data-testid^="pipeline-def-inspect-"]:not([disabled])').first()
  await expect(inspect).toBeVisible()
  await inspect.click()

  await expect(page.getByTestId('pipeline-def-inspector')).toBeVisible({ timeout: 15_000 })
  const graph = page.getByTestId('pipeline-graph')
  await expect(graph).toBeVisible({ timeout: 15_000 })
  // The React Flow canvas actually laid out nodes (dagre ran, nodes mounted) —
  // the whole point of Lane A: a definition renders a graph, not just text lists.
  await expect(graph.locator('.react-flow__node').first()).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'ui-refinement-def-inspector-graph')
})

test('B. wallpaper: solid + gradient presets render behind the frosted glass', async ({ page }) => {
  await openApp(page, '#/settings')
  await page.getByTestId('appearance-section').scrollIntoViewIfNeeded()
  const bg = page.getByTestId('app-background')
  const kind = page.getByTestId('background-kind-select')

  // Solid.
  await kind.selectOption('solid')
  await expect(bg).toHaveAttribute('data-variant', 'solid', { timeout: 10_000 })
  await screenshot(page, 'ui-refinement-wallpaper-solid')

  // Gradient + a specific preset.
  await kind.selectOption('gradient')
  await expect(bg).toHaveAttribute('data-variant', 'gradient', { timeout: 10_000 })
  const preset = page.getByTestId('background-preset-select')
  await preset.selectOption('ocean')
  // The Select is server-state-controlled — wait for the mutation to round-trip
  // so the value (and the wallpaper) actually reflect 'ocean' before the shot.
  await expect(preset).toHaveValue('ocean', { timeout: 10_000 })
  await expect(page.getByTestId('background-preview')).toBeVisible()
  await screenshot(page, 'ui-refinement-wallpaper-gradient-ocean')
})

test('B. wallpaper: uploading an image switches the background to that image', async ({ page }) => {
  await openApp(page, '#/settings')
  await page.getByTestId('appearance-section').scrollIntoViewIfNeeded()

  // The <input type="file"> is sr-only, driven by a styled Button — set files
  // directly (Playwright fires the change event onto the hidden input).
  await page.getByTestId('background-image-input').setInputFiles(pngPath)

  const bg = page.getByTestId('app-background')
  await expect(bg).toHaveAttribute('data-variant', 'image', { timeout: 15_000 })
  // Uploading flips the persisted kind to 'image' server-side; the select follows.
  await expect(page.getByTestId('background-kind-select')).toHaveValue('image')
  await screenshot(page, 'ui-refinement-wallpaper-image')
})

test('D. settings sidebar scrolls to a section without hijacking the hash route', async ({ page }) => {
  await openApp(page, '#/settings')

  const hashBefore = await page.evaluate(() => location.hash)
  const target = page.locator('#autonomy')
  const yBefore = (await target.boundingBox())?.y ?? 0

  // Click a nav item far down the list.
  const navBtn = page.getByRole('button', { name: 'Autonomous Org' })
  await expect(navBtn).toBeVisible()
  await navBtn.click()
  await page.waitForTimeout(700) // let the smooth scroll settle

  // THE regression guard: an <a href="#autonomy"> would set location.hash and
  // the hash router would navigate away from Settings to a 404. A button +
  // scrollIntoView must leave the hash untouched.
  expect(await page.evaluate(() => location.hash)).toBe(hashBefore)
  // …and we are still on Settings (an appearance section only Settings renders).
  await expect(page.getByTestId('appearance-section')).toBeVisible()
  // …and the click actually scrolled the target section upward toward the top.
  const yAfter = (await target.boundingBox())?.y ?? 0
  expect(yAfter).toBeLessThan(yBefore)
  await screenshot(page, 'ui-refinement-settings-sidebar')
})

test.afterEach(() => {
  // A client SPA blank screen is almost always an uncaught throw at
  // render/module-eval. Fail loudly on any uncaught page error.
  expect(sink.pageErrors, `uncaught page errors:\n${sink.pageErrors.join('\n')}`).toEqual([])
  const fatal = sink.errors.filter(e => /AFRAME|is not defined|Cannot read|Minified React error/i.test(e))
  expect(fatal, `fatal console errors:\n${fatal.join('\n')}`).toEqual([])
})

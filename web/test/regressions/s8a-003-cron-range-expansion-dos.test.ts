/**
 * CONFIRMED FAULT — finding S8-003 (see testing/findings/S8-web-ui.md).
 *
 * Surface: web/src/lib/cron.ts :: convertRange / checkCron.
 *
 * `convertRange` materialises an ENTIRE numeric range into an array + joined
 * string BEFORE any per-field bounds check, and its loop is
 * `for (let i = first; i <= last; i += step)` with no guard on `step`.
 *
 * Expected: `checkCron`, an inline-hint validator that runs on every keystroke,
 *   rejects implausible expressions cheaply and NEVER hangs/OOMs the thread.
 *   - a zero step (a step of 0, e.g. an every-N field of zero, or "1-5 / 0")
 *     -> { valid: false }
 *   - an oversized range ("1-5000000" in a field) -> { valid: false }
 * Actual:
 *   - zero step -> `i` never advances -> unbounded array growth -> fatal V8
 *     "invalid size" abort (the browser tab crashes).
 *   - oversized range -> multi-second synchronous freeze (~3.4s for 2M) building
 *     a giant array/string before the out-of-range value is ever checked.
 *
 * We run the REAL source in a heap-constrained, disposable worker so the DoS is
 * observed without crashing or hanging this test process: a fixed validator
 * returns `{ valid: false }` in trivial memory; the buggy one blows the worker
 * heap (contained ERR_WORKER_OUT_OF_MEMORY) or is terminated at the time bound.
 * RED until convertRange bounds-checks before expanding and rejects step <= 0.
 *
 * prober: PROBER-A · validator: VALIDATOR-A
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

type Outcome =
  | { outcome: 'returned'; value: { valid: boolean; error?: string } }
  | { outcome: 'oom' }
  | { outcome: 'timeout' }
  | { outcome: 'exit'; code: number }

let cronJs = ''

beforeAll(async () => {
  // Compile the real cron.ts to CJS with vite's bundled esbuild (vite is a
  // first-class web dep, resolvable in the vitest runtime). No source copy.
  const vite = await import('vite')
  const src = readFileSync(path.resolve(here, '../../src/lib/cron.ts'), 'utf8')
  cronJs = (await vite.transformWithEsbuild(src, 'cron.ts', { loader: 'ts', format: 'cjs' })).code
})

/**
 * Run `checkCron(pattern)` on the compiled source inside a heap-limited worker.
 * - returns        -> the validator produced a verdict (the SAFE outcome)
 * - oom            -> it blew the 64MB heap (contained, parent unaffected)
 * - timeout        -> still running after the bound -> terminated cleanly
 * The worker can never crash THIS process: array-size OOM is caught as
 * ERR_WORKER_OUT_OF_MEMORY by resourceLimits, and runaway loops are terminated.
 */
function checkCronBounded(pattern: string, timeoutMs = 4000): Promise<Outcome> {
  const harness = `
    const { parentPort, workerData } = require('node:worker_threads')
    const module = { exports: {} }; const exports = module.exports;
    ${cronJs}
    parentPort.postMessage(module.exports.checkCron(workerData.pattern))
  `
  return new Promise(resolve => {
    const w = new Worker(harness, {
      eval: true,
      workerData: { pattern },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    })
    const timer = setTimeout(() => { void w.terminate(); resolve({ outcome: 'timeout' }) }, timeoutMs)
    w.on('message', value => { clearTimeout(timer); void w.terminate(); resolve({ outcome: 'returned', value }) })
    w.on('error', err => {
      clearTimeout(timer)
      resolve(String(err).includes('ERR_WORKER_OUT_OF_MEMORY') ? { outcome: 'oom' } : { outcome: 'exit', code: -1 })
    })
    w.on('exit', code => { clearTimeout(timer); if (code !== 0) resolve({ outcome: 'exit', code }) })
  })
}

describe('S8-003 — cron validator must not hang/OOM on range expansion', () => {
  it('sanity: a realistic valid expression returns a verdict cheaply', async () => {
    // Guards the harness itself — normal validation fits well inside the heap.
    const r = await checkCronBounded('*/5 9-17 * * 1-5')
    expect(r).toEqual({ outcome: 'returned', value: { valid: true } })
  })

  it('rejects a zero-step range instead of looping unbounded', async () => {
    const r = await checkCronBounded('*/0 * * * *')
    expect(r).toEqual({ outcome: 'returned', value: expect.objectContaining({ valid: false }) })
  })

  it('rejects an explicit a-b/0 zero step', async () => {
    const r = await checkCronBounded('1-5/0 * * * *')
    expect(r).toEqual({ outcome: 'returned', value: expect.objectContaining({ valid: false }) })
  })

  it('rejects an oversized range without materialising it', async () => {
    const r = await checkCronBounded('1-5000000 * * * *')
    expect(r).toEqual({ outcome: 'returned', value: expect.objectContaining({ valid: false }) })
  })
})

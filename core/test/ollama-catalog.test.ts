/**
 * OllamaCatalog unit tests.
 *
 * Uses vi.spyOn(fs.promises, 'statfs') rather than vi.mock('node:fs') to avoid
 * CJS-compat module-mock spread issues: spyOn modifies the shared fs.promises
 * object in place so the same reference used by ollama-catalog.ts is intercepted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { CATALOG, freeDiskBytes, fitsOnDisk } from '../src/ollama-catalog.js'

afterEach(() => {
  vi.restoreAllMocks()
})

// ── CATALOG shape ─────────────────────────────────────────────────────────────

describe('CATALOG', () => {
  it('contains at least 5 entries with required fields', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(5)
    for (const entry of CATALOG) {
      expect(typeof entry.name).toBe('string')
      expect(typeof entry.label).toBe('string')
      expect(typeof entry.sizeBytes).toBe('number')
      expect(entry.sizeBytes).toBeGreaterThan(0)
      expect(typeof entry.blurb).toBe('string')
    }
  })

  it('includes the expected models', () => {
    const names = CATALOG.map(e => e.name)
    expect(names).toContain('qwen2.5:0.5b')
    expect(names).toContain('llama3.2:3b')
    expect(names).toContain('mistral:7b')
    expect(names).toContain('qwen2.5-coder:7b')
    expect(names).toContain('phi4')
  })
})

// ── freeDiskBytes ─────────────────────────────────────────────────────────────

describe('freeDiskBytes', () => {
  it('returns bavail * bsize from statfs', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { bavail: 10_000, bsize: 4096 } as any,
    )
    const bytes = await freeDiskBytes()
    expect(bytes).toBe(10_000 * 4096)
  })

  it('falls back to MAX_SAFE_INTEGER when statfs throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockRejectedValue(new Error('ENOSYS'))
    const bytes = await freeDiskBytes()
    expect(bytes).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// ── fitsOnDisk ────────────────────────────────────────────────────────────────

describe('fitsOnDisk', () => {
  it('returns true when model is smaller than free space (with 5% headroom)', async () => {
    // 10 GB free → bavail*bsize = 10 * 1024^3
    const tenGb = 10 * 1024 * 1024 * 1024
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { bavail: tenGb, bsize: 1 } as any,
    )
    // 1 GB model fits in 10 GB (well within 95% of free space)
    const fits = await fitsOnDisk(1024 * 1024 * 1024)
    expect(fits).toBe(true)
  })

  it('returns false when model is larger than available free space', async () => {
    // 400 KB free
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { bavail: 100, bsize: 4096 } as any, // 409,600 bytes
    )
    // 1 GB model does NOT fit in 400 KB
    const fits = await fitsOnDisk(1024 * 1024 * 1024)
    expect(fits).toBe(false)
  })

  it('returns true (optimistic) when statfs is unavailable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockRejectedValue(new Error('ENOSYS'))
    // freeDiskBytes falls back to MAX_SAFE_INTEGER so anything "fits"
    const fits = await fitsOnDisk(100 * 1024 * 1024 * 1024) // 100 GB
    expect(fits).toBe(true)
  })
})

// ── catalog installed annotation logic ───────────────────────────────────────
// The annotation (installed: bool) is applied in the route handler. Test the
// Set-membership logic inline — it's trivial but worth covering as a contract.

describe('catalog annotation logic (inline)', () => {
  it('marks a model as installed when its name is in the installed list', () => {
    const installed = [{ name: 'llama3.2:3b' }, { name: 'mistral:7b' }]
    const installedNames = new Set(installed.map(m => m.name))
    const annotated = CATALOG.map(e => ({ ...e, installed: installedNames.has(e.name) }))

    const llama = annotated.find(e => e.name === 'llama3.2:3b')
    const qwen = annotated.find(e => e.name === 'qwen2.5:0.5b')
    expect(llama?.installed).toBe(true)
    expect(qwen?.installed).toBe(false)
  })

  it('marks nothing installed when the installed list is empty', () => {
    const installedNames = new Set<string>()
    const annotated = CATALOG.map(e => ({ ...e, installed: installedNames.has(e.name) }))
    expect(annotated.every(e => !e.installed)).toBe(true)
  })
})

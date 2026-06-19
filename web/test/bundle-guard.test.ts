import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for the blank-screen bug (Phase 3 close-out, 2026-06-19).
 *
 * The aggregate `react-force-graph` package bundles the 3D/VR/AR renderers, whose
 * module bodies reference a global `AFRAME` that does not exist in a plain browser.
 * Importing it therefore throws `ReferenceError: AFRAME is not defined` at module
 * evaluation time — and because Shell statically imports the graph pages, that throw
 * crashed the ENTIRE React tree (blank screen on every route). typecheck, build, and
 * the unit suite all passed regardless, because the crash only happens in a real
 * browser at runtime. We import the 2D-only subpackage `react-force-graph-2d` instead.
 *
 * This static guard fails in CI if anything re-introduces the aggregate import.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('bundle guard — no aggregate react-force-graph import', () => {
  it('only the 2D subpackage is imported (the aggregate pulls in AFRAME and blanks the app)', () => {
    const srcDir = join(__dirname, '..', 'src')
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => /from\s+['"]react-force-graph['"]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

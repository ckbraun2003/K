import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for the blank-screen bug (Phase 3 close-out, 2026-06-19).
 *
 * The aggregate `react-force-graph` package (and its `-vr`/`-ar` subpackages) bundle
 * the VR/AR renderers, whose module bodies reference a global `AFRAME` that does not
 * exist in a plain browser. Importing them therefore throws `ReferenceError: AFRAME is
 * not defined` at module evaluation time — and because Shell statically imports the
 * graph pages, that throw crashed the ENTIRE React tree (blank screen on every route).
 * typecheck, build, and the unit suite all passed regardless, because the crash only
 * happens in a real browser at runtime.
 *
 * The app now renders its graphs with the Three.js-based `react-force-graph-3d`
 * subpackage (deps: 3d-force-graph, react-kapsule, prop-types, three — no AFRAME);
 * the 2D subpackage `react-force-graph-2d` is also allowed. This guard still blocks the
 * AFRAME-bearing aggregate (`react-force-graph`) and its `-vr`/`-ar` subpackages.
 *
 * This static guard fails in CI if anything re-introduces an AFRAME-bearing import.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Matches the AFRAME-bearing aggregate `react-force-graph` and its `-vr`/`-ar`
// subpackages, but NOT the allowed `-2d`/`-3d` (those have a non-quote char after
// `react-force-graph`, so the trailing quote class fails to match). Two patterns:
//   1. static `from '…'` and side-effect `import '…'` (no `from`)
//   2. dynamic `import('…')`
const STATIC_OR_SIDE_EFFECT = /(?:from|import)\s+['"]react-force-graph(?:-vr|-ar)?['"]/
const DYNAMIC = /import\(\s*['"]react-force-graph(?:-vr|-ar)?['"]\s*\)/

describe('bundle guard — no AFRAME-bearing react-force-graph import', () => {
  it('forbids the aggregate and -vr/-ar subpackages via static/side-effect/dynamic import (they pull in AFRAME and blank the app); -2d/-3d are allowed', () => {
    const srcDir = join(__dirname, '..', 'src')
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
        return STATIC_OR_SIDE_EFFECT.test(src) || DYNAMIC.test(src)
      })
    expect(offenders).toEqual([])
  })
})

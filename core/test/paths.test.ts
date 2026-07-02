/**
 * paths.ts::isPathWithin — the shared path-traversal guard.
 *
 * Regression focus: the LIVE dispatch-bricking bug where a mixed-separator root
 * (e.g. K_DATA_DIR set to `C:\\Users\\x\\repo/e2e/.data/ws-smoke` — backslashes from
 * the repo path, forward slashes from the configured suffix) never string-prefix-
 * matched a `path.resolve`'d absolute path, so EVERY containment check failed and
 * every dispatch died with "agent-config: path escapes configDir". isPathWithin now
 * path.resolve()s BOTH sides before comparing, preserving the documented
 * inclusive/exclusive semantics and the trailing-separator drive-root case.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { isPathWithin } from '../src/paths.js'

describe('isPathWithin', () => {
  it('platform-agnostic: a child built with path.join is within its root', () => {
    const root = path.join(process.cwd(), 'some', 'root')
    expect(isPathWithin(root, path.join(root, 'child.txt'))).toBe(true)
    expect(isPathWithin(root, path.join(root, 'nested', 'deep', 'file.json'))).toBe(true)
  })

  it('mixed separators: a root carrying forward slashes still contains a natively-resolved child', () => {
    // The live-repro shape: the ROOT arrives with mixed/foreign separators (a
    // configured suffix appended with '/'), while the candidate was path.resolve'd
    // to native separators. Raw prefix matching failed here; resolve-both fixes it.
    const nativeRoot = path.join(process.cwd(), 'e2e', '.data', 'ws-smoke')
    const mixedRoot = `${process.cwd()}/e2e/.data/ws-smoke`
    const abs = path.resolve(nativeRoot, 'agent-config', 'mcp.json')
    expect(isPathWithin(mixedRoot, abs)).toBe(true)
  })

  it.runIf(process.platform === 'win32')('win32: a backslash root vs a forward-slash abs (and vice versa) match', () => {
    // Both orientations of the live failure, Windows-only (backslash is a path
    // separator ONLY on win32; on POSIX it is a literal filename character).
    expect(isPathWithin('C:\\Users\\x\\repo/e2e/.data/ws-smoke', 'C:\\Users\\x\\repo\\e2e\\.data\\ws-smoke\\sub')).toBe(true)
    expect(isPathWithin('C:\\Users\\x\\repo\\e2e\\.data\\ws-smoke', 'C:/Users/x/repo/e2e/.data/ws-smoke/sub')).toBe(true)
  })

  it('`..` escape is still rejected (even when it sneaks past a raw prefix)', () => {
    const root = path.join(process.cwd(), 'safe-root')
    expect(isPathWithin(root, path.join(root, '..', 'outside.txt'))).toBe(false)
    // An UNRESOLVED candidate whose raw string starts with the root but resolves
    // outside it — resolve-both must reject it.
    expect(isPathWithin(root, `${root}${path.sep}..${path.sep}evil`)).toBe(false)
  })

  it('abs === root: false by default, true with inclusive', () => {
    const root = path.join(process.cwd(), 'eq-root')
    expect(isPathWithin(root, root)).toBe(false)
    expect(isPathWithin(root, root, { inclusive: true })).toBe(true)
    // Equality also holds across separator styles after resolution.
    expect(isPathWithin(root, root.split(path.sep).join('/'), { inclusive: true })).toBe(true)
  })

  it('a sibling directory sharing the root as a string prefix is rejected', () => {
    const root = path.join(process.cwd(), 'a', 'b')
    const sibling = path.join(process.cwd(), 'a', 'bc')
    expect(isPathWithin(root, sibling)).toBe(false)
    expect(isPathWithin(root, path.join(sibling, 'file'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('win32: a drive-root root (trailing separator) still works', () => {
    // path.resolve keeps 'C:\\' as 'C:\\' — the endsWith(path.sep) branch must not
    // double the separator.
    expect(isPathWithin('C:\\', 'C:\\anything\\below')).toBe(true)
    expect(isPathWithin('C:\\', 'C:\\')).toBe(false)
    expect(isPathWithin('C:\\', 'C:\\', { inclusive: true })).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('posix: the filesystem root (trailing separator) still works', () => {
    expect(isPathWithin('/', '/anything/below')).toBe(true)
    expect(isPathWithin('/', '/')).toBe(false)
    expect(isPathWithin('/', '/', { inclusive: true })).toBe(true)
  })
})

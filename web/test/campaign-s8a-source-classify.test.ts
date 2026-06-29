import { describe, it, expect } from 'vitest'
import { classifySource, isPathLike, isGithubUrl } from '../src/lib/source'

/**
 * S8a LOCK — source classification precedence + conservative gating.
 *
 * Pins two NEW, non-obvious characterizations (beyond the existing source suite):
 *   1. URL detection wins over path detection, so a LOCAL bare-repo path that
 *      ends in `.git` is intentionally classified as a 'url' (clone path), not a
 *      'path' (register-in-place). This is documented intent in source.ts.
 *   2. The relative-path regex class `[\w.\- ]` is ASCII-only, so a path whose
 *      first segment is non-ASCII is conservatively gated as 'invalid' client
 *      side (the server still validates). Documented here so a future change to
 *      support unicode paths flips this test deliberately, not by accident.
 */

describe('S8a — `.git` suffix makes URL detection win over path detection', () => {
  it('a Windows/relative local path ending in .git classifies as url', () => {
    expect(isGithubUrl('C:\\repo.git')).toBe(true)
    expect(classifySource('C:\\repo.git')).toBe('url')
    expect(classifySource('./repo.git')).toBe('url')
  })

  it('the same local paths WITHOUT a .git suffix are still paths', () => {
    expect(classifySource('C:\\repo')).toBe('path')
    expect(classifySource('./repo')).toBe('path')
  })
})

describe('S8a — non-ASCII leading path segment is conservatively gated', () => {
  it('a unicode path is classified invalid by the client gate', () => {
    expect(isPathLike('café/repo')).toBe(false)
    expect(classifySource('café/repo')).toBe('invalid')
  })

  it('an equivalent ASCII path IS recognised (proving the gate is the unicode class, not the separator)', () => {
    expect(classifySource('cafe/repo')).toBe('path')
  })

  it('an absolute unicode path under a known prefix is still recognised (prefix matches before the class)', () => {
    // Leading `/` / `~` / drive are matched before the ASCII-only relative class.
    expect(classifySource('/srv/café/repo')).toBe('path')
    expect(classifySource('C:\\café\\repo')).toBe('path')
  })
})

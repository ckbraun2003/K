/**
 * Task 12 Step 2 — localStorage-backed diff prefs: unified/split mode +
 * per-diff-identity viewed-file marks.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { getDiffMode, setDiffMode, diffIdentity, getViewed, toggleViewed } from '../src/lib/diff-prefs'

describe('diff-prefs', () => {
  beforeEach(() => localStorage.clear())
  it('persists the unified/split mode (default split)', () => {
    expect(getDiffMode()).toBe('split')
    setDiffMode('unified')
    expect(getDiffMode()).toBe('unified')
  })
  it('keys viewed marks by baseRef..headRef and toggles per path', () => {
    const id = diffIdentity({ baseRef: 'aaa', headRef: 'bbb' })
    expect(getViewed(id).size).toBe(0)
    toggleViewed(id, 'src/a.ts')
    expect(getViewed(id).has('src/a.ts')).toBe(true)
    toggleViewed(id, 'src/a.ts')
    expect(getViewed(id).has('src/a.ts')).toBe(false)
    // a different diff identity is independent
    expect(getViewed(diffIdentity({ baseRef: 'ccc', headRef: 'ddd' })).size).toBe(0)
  })
})
